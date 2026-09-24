// pstb — turns a list of .eml files into one or more Outlook PST files.
//
// The worker runs this as a child process, exactly the way it already runs
// tesseract, pdftoppm and soffice. It reads a job file, writes PSTs, and prints
// ONE line of JSON on stdout. Nothing else is ever written to stdout, because
// the caller parses stdout.
//
// Input (job JSON):
//   {
//     "outPath": "/var/lib/cdfir/export-scratch/<id>/export.pst",
//     "maxBytesPerPart": 10737418240,
//     "storeDisplayName": "Acme v Widgets - export 3",
//     "spoolDir": "/var/lib/cdfir/export-scratch/<id>/spool",
//     "spoolThresholdBytes": 1048576,
//     "messages": [ { "path": "...eml", "folderPath": "Inbox", "receivedUtc": "2024-01-02T03:04:05Z" } ]
//   }
//
// Output (one line of JSON):
//   { "ok": true, "messagesAdded": 4440, "parts": [ { "path": "...", "bytes": 123 } ], ... }
//
// Exit 0 only when every message was added. Any message that fails is named in
// "failures" and the exit code is 1, because an export that quietly dropped
// evidence is the one outcome this product must never produce.

using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using MimeKit;
using PstBuilder.Eml;
using PstBuilder.Messaging;

namespace Cdfir.Pstb;

internal sealed class Job
{
    public string OutPath { get; set; } = "";
    public long MaxBytesPerPart { get; set; }
    public string StoreDisplayName { get; set; } = "Personal Folders";
    public string SpoolDir { get; set; } = "";

    /// <summary>
    /// Attachments at or above this many bytes are decoded to a spool file and
    /// streamed into the PST instead of being held in memory. Set it above the
    /// largest attachment to get the all-in-memory behaviour, which is what the
    /// byte-identical comparison test does.
    /// </summary>
    public long SpoolThresholdBytes { get; set; } = 1L * 1024 * 1024;

    public List<JobMessage> Messages { get; set; } = new();
}

internal sealed class JobMessage
{
    public string Path { get; set; } = "";
    public string FolderPath { get; set; } = "";
    public DateTime? ReceivedUtc { get; set; }
}

/// <summary>
/// The one line of JSON this program prints, as an explicit named type rather
/// than an anonymous one.
///
/// This is the contract the worker parses, so it is worth being able to read it
/// in one place. It is also cheap insurance: reflection-based serialization of
/// anonymous types out of a single-file publish is the fragile corner of
/// System.Text.Json, and there is no reason to sit in it.
///
/// A warning for anyone debugging this on an Apple Silicon Mac: running the
/// linux-x64 build under QEMU emulation corrupts 32-bit integers in this output.
/// `messagesAdded` and `spooledAttachments` come back as strings of nulls and
/// `peakWorkingSetMiB` reads 1817 instead of 70, while the PST files themselves
/// are byte-for-byte correct. That is an emulator artifact, not a bug here —
/// the same source built for linux-arm64 and run natively reports every field
/// correctly. Do not trust metrics measured under `--platform linux/amd64` on
/// an arm64 host.
/// </summary>
internal sealed class Report
{
    public bool Ok { get; set; }
    public string Fatal { get; set; } = "";
    public int MessagesRequested { get; set; }
    public int MessagesAdded { get; set; }
    public List<string> Failures { get; set; } = new();
    public long InputBytes { get; set; }
    public long OutputBytes { get; set; }
    public List<PartInfo> Parts { get; set; } = new();
    public int SpooledAttachments { get; set; }
    public double Seconds { get; set; }
    public double PeakWorkingSetMiB { get; set; }
    public bool NamedPropertySeeded { get; set; }
}

internal sealed class PartInfo
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public long Bytes { get; set; }
}

internal static class Program
{
    /// <summary>
    /// libpff refuses to open a PST whose Name-to-ID map holds no entries at
    /// all: "libpff_name_to_id_map_read: missing name to id map entries data".
    /// The writer only emits map entries for named properties that are actually
    /// used, and ordinary mail uses none, so a PST of plain email is rejected
    /// outright by every libpff-based tool — including our own validation.
    ///
    /// Attaching ONE harmless named property per message fills the map. It is a
    /// derived property, not collected evidence, so it is declared in the export
    /// manifest and in TRUTHFULNESS_NOTICES.pstExport.
    ///
    /// This failure is silent and total, which is why `pst-vendor.test.ts`
    /// asserts these lines still exist rather than trusting a comment.
    /// </summary>
    private const ushort MarkerPropertyId = 0x8580;

    private const string MarkerPropertyValue = "aeg-clouddfir-export";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: pstb <job.json>");
            return 2;
        }

        Job job;
        try
        {
            job = JsonSerializer.Deserialize<Job>(File.ReadAllText(args[0]), JsonOpts)
                  ?? throw new InvalidDataException("job file parsed to null");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"cannot read job file: {ex.Message}");
            return 2;
        }

        if (job.Messages.Count == 0)
        {
            Console.Error.WriteLine("job lists no messages");
            return 2;
        }

        var sw = Stopwatch.StartNew();
        var failures = new List<string>();
        long inputBytes = 0;
        var added = 0;
        var spooledAttachments = 0;
        var spoolFiles = new List<string>();

        // Environment.WorkingSet is sampled on a thread because
        // Process.PeakWorkingSet64 reports 0 on some platforms, and peak memory
        // is the number that decides whether this can run beside the rest of the
        // worker on an 8-core, 31 GB host.
        // Both the sampler thread and the main thread touch these, so both go
        // through Interlocked/Volatile. The first Linux run produced
        // `peakWorkingSetMiB: 275712328792` from the unsynchronised version —
        // a torn read, not a real measurement. A number that can be garbage is
        // worse than no number, because it will be quoted in a capacity
        // decision.
        var peak = new long[1];
        var sampling = new bool[1] { true };
        var sampler = new Thread(() =>
        {
            while (Volatile.Read(ref sampling[0]))
            {
                var ws = Environment.WorkingSet;
                if (ws > Interlocked.Read(ref peak[0])) Interlocked.Exchange(ref peak[0], ws);
                Thread.Sleep(20);
            }
        }) { IsBackground = true };
        sampler.Start();

        void StopSampling()
        {
            Volatile.Write(ref sampling[0], false);
            sampler.Join(TimeSpan.FromMilliseconds(200));
            var ws = Environment.WorkingSet;
            if (ws > Interlocked.Read(ref peak[0])) Interlocked.Exchange(ref peak[0], ws);
        }

        long PeakMiB() => Interlocked.Read(ref peak[0]);

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(job.OutPath)!);
            if (job.SpoolDir != "") Directory.CreateDirectory(job.SpoolDir);

            // CreateSplit, never Create. Each part it writes is a COMPLETE,
            // independently-openable PST, not a byte-range volume of one big
            // file. A recipient who never rejoins a volume set cannot tell it
            // from a corrupt evidence file, and that is not a sentence anyone
            // wants said in a deposition. `pst-export.test.ts` and the libpff
            // oracle in verify.py both check that every part opens on its own.
            using var session = PstExportSession.CreateSplit(
                job.OutPath, job.MaxBytesPerPart, job.StoreDisplayName);

            foreach (var m in job.Messages)
            {
                try
                {
                    var r = AddMessage(session, job, m, spoolFiles);
                    inputBytes += r.bytes;
                    spooledAttachments += r.spooled;
                    added++;
                }
                catch (Exception ex)
                {
                    failures.Add($"{m.Path}: {ex.GetType().Name}: {ex.Message}");
                    // Bounded: a systemic fault (unwritable spool directory, full
                    // disk) would otherwise produce one line per message for
                    // 170,000 messages before anyone saw the first one.
                    if (failures.Count >= 50) break;
                }
            }

            var result = session.Complete();
            sw.Stop();
            StopSampling();

            var parts = new List<PartInfo>();
            long outBytes = 0;
            foreach (var p in result.Parts)
            {
                var fi = new FileInfo(p.Name);
                if (!fi.Exists) continue;
                outBytes += fi.Length;
                parts.Add(new PartInfo { Path = fi.FullName, Name = fi.Name, Bytes = fi.Length });
            }

            Emit(new Report
            {
                Ok = failures.Count == 0,
                MessagesRequested = job.Messages.Count,
                MessagesAdded = added,
                Failures = failures,
                InputBytes = inputBytes,
                OutputBytes = outBytes,
                Parts = parts,
                SpooledAttachments = spooledAttachments,
                Seconds = Math.Round(sw.Elapsed.TotalSeconds, 3),
                PeakWorkingSetMiB = Math.Round(PeakMiB() / 1048576.0, 1),
                NamedPropertySeeded = true,
            });
            return failures.Count == 0 ? 0 : 1;
        }
        catch (Exception ex)
        {
            sw.Stop();
            StopSampling();
            Emit(new Report
            {
                Ok = false,
                // The INNER exception, unwrapped. The session reports a consumer
                // thread fault as "Export failed; see inner exception", and
                // printing only that says nothing at all — it cost a debugging
                // round trip the first time this fired on Linux.
                Fatal = Describe(ex),
                MessagesRequested = job.Messages.Count,
                MessagesAdded = added,
                Failures = failures,
                Seconds = Math.Round(sw.Elapsed.TotalSeconds, 3),
                PeakWorkingSetMiB = Math.Round(PeakMiB() / 1048576.0, 1),
            });
            return 1;
        }
        finally
        {
            // Spool files are decoded copies of attachment bytes. They are not
            // evidence, and they must not be left on the scratch volume, which
            // shares a disk with PostgreSQL.
            foreach (var f in spoolFiles)
            {
                try { File.Delete(f); } catch { /* best effort */ }
            }
        }
    }

    /// <summary>
    /// Add one .eml. Returns its size on disk and how many of its attachments
    /// were streamed rather than buffered.
    ///
    /// Three things here are deliberate, and all three are about memory. The
    /// real corpus has a 672 MB item, and the spike measured a 684 MiB message
    /// costing 2,486 MiB peak — about 3.6x — on the straightforward route.
    ///
    /// 1. `persistent: true`. The default `MimeMessage.Load` copies every part's
    ///    content into memory as it parses. Persistent mode keeps a window onto
    ///    the FileStream instead, so nothing is resident and `Content.Stream`
    ///    reports the encoded length without reading it.
    ///
    /// 2. Large parts are decoded straight to a spool file and then BLANKED in
    ///    the MIME tree, before `EmlMapper.ToMessageItem` ever sees them.
    ///    Upstream's mapper does `DecodeTo(MemoryStream)` then `ToArray()` — a
    ///    growing buffer plus a second full copy of it — so blanking first is
    ///    what actually avoids the peak. Doing it afterwards would be too late.
    ///
    /// 3. Small attachments stay in memory on purpose. 170,000 messages of
    ///    ordinary mail would otherwise put millions of tiny files on the
    ///    scratch volume for no gain.
    /// </summary>
    private static (long bytes, int spooled) AddMessage(
        PstExportSession session, Job job, JobMessage m, List<string> spoolFiles)
    {
        var size = new FileInfo(m.Path).Length;
        var spooled = 0;

        using (var fs = new FileStream(m.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var mime = MimeMessage.Load(ParserOptions.Default, fs, persistent: true);

            // The same sequence of parts, in the same order, that
            // EmlMapper.AddAttachments will turn into AttachmentItems. Kept in
            // step with it by the hard count check below, not by hope.
            var ordered = AttachmentParts(mime);

            var spooledPaths = new string[ordered.Count];
            if (job.SpoolDir != "")
            {
                for (var i = 0; i < ordered.Count; i++)
                {
                    var part = ordered[i];
                    if (!ShouldSpool(part, job.SpoolThresholdBytes)) continue;
                    var spool = Path.Combine(job.SpoolDir, $"{Guid.NewGuid():N}.bin");
                    using (var outFs = new FileStream(spool, FileMode.CreateNew, FileAccess.Write))
                    {
                        part.Content.DecodeTo(outFs);
                    }
                    spoolFiles.Add(spool);
                    spooledPaths[i] = spool;
                    // Blank it so the mapper buffers nothing for this part. The
                    // real bytes go back in as a streamed attachment below.
                    part.Content = new MimeContent(new MemoryStream(Array.Empty<byte>()));
                }
            }

            var item = EmlMapper.ToMessageItem(mime, m.ReceivedUtc);

            if (item.Attachments.Count != ordered.Count)
            {
                // The mapper's attachment order is upstream's business, and we
                // mirrored it to know which AttachmentItem belongs to which part.
                // If that ever stops matching, replacing by index would attach
                // one message's bytes under another's filename. Refusing the
                // message is the only safe answer; it is named in `failures` and
                // the export fails rather than shipping wrong evidence.
                throw new InvalidOperationException(
                    $"attachment mapping drifted: mapper produced {item.Attachments.Count} " +
                    $"attachment(s), this build expected {ordered.Count}");
            }

            for (var i = 0; i < spooledPaths.Length; i++)
            {
                var spool = spooledPaths[i];
                if (spool == null) continue;
                var was = item.Attachments[i];
                var streamed = AttachmentItem.FromFile(spool, was.FileName, was.MimeType);
                streamed.ContentId = was.ContentId;
                streamed.IsInline = was.IsInline;
                item.Attachments[i] = streamed;
                spooled++;
            }

            // See MarkerPropertyId: with no named property anywhere in the file,
            // libpff will not open it at all.
            item.NamedProperties.Add(
                NamedProperty.Text(PropertySets.Common, MarkerPropertyId, MarkerPropertyValue));

            // A real folder path can be an opaque Graph id, or absent entirely.
            var folder = string.IsNullOrWhiteSpace(m.FolderPath) ? "Unfiled" : m.FolderPath;

            // Inside the `using`: in persistent mode the small attachments the
            // mapper buffered are already copies, but the blanked parts are not
            // read again, so the FileStream is only needed until AddMessage
            // returns. AddMessage queues a fully-materialised item.
            session.AddMessage(folder, item);
        }

        return (size, spooled);
    }

    /// <summary>
    /// The parts EmlMapper turns into attachments, in its order: explicit
    /// attachments first, then inline cid resources from the body parts.
    ///
    /// This mirrors `EmlMapper.AddAttachments`. It is a copy of somebody else's
    /// rule, so `AddMessage` refuses the message if the two ever disagree about
    /// how many attachments a message has.
    /// </summary>
    private static List<MimePart> AttachmentParts(MimeMessage mime)
    {
        var explicitParts = new HashSet<MimeEntity>(mime.Attachments);
        var ordered = new List<MimePart>();
        foreach (var p in mime.Attachments)
        {
            if (p is MimePart mp) ordered.Add(mp);
        }
        foreach (var p in mime.BodyParts)
        {
            if (p is not MimePart mp) continue;
            if (explicitParts.Contains(mp)) continue;
            if (string.IsNullOrEmpty(mp.ContentId)) continue;
            if (mp.ContentType.MediaType.Equals("text", StringComparison.OrdinalIgnoreCase)) continue;
            ordered.Add(mp);
        }
        return ordered;
    }

    /// <summary>
    /// Whether this part is big enough to be worth a spool file.
    ///
    /// The encoded length is used, which for base64 is about 4/3 of the decoded
    /// length — an over-estimate, so the threshold errs toward streaming. A part
    /// whose length cannot be read is spooled, because an unknown size is not a
    /// reason to risk holding it.
    /// </summary>
    private static bool ShouldSpool(MimePart part, long thresholdBytes)
    {
        var stream = part.Content?.Stream;
        if (stream == null) return false;
        if (!stream.CanSeek) return true;
        try
        {
            return stream.Length >= thresholdBytes;
        }
        catch (NotSupportedException)
        {
            return true;
        }
    }

    /// <summary>
    /// Every exception in the chain, plus the deepest stack frame.
    ///
    /// `PstExportSession` runs its writer on a background consumer thread and
    /// surfaces a fault as `InvalidOperationException: Export failed; see inner
    /// exception`. That sentence on its own is useless, and it is the message an
    /// operator would otherwise see in a failed export.
    /// </summary>
    private static string Describe(Exception ex)
    {
        var parts = new List<string>();
        var current = ex;
        var depth = 0;
        while (current != null && depth++ < 6)
        {
            parts.Add($"{current.GetType().Name}: {current.Message}");
            current = current.InnerException;
        }
        var frame = ex.GetBaseException().StackTrace?.Split('\n').FirstOrDefault()?.Trim();
        if (!string.IsNullOrEmpty(frame)) parts.Add($"at {frame}");
        return string.Join(" -> ", parts);
    }

    /// <summary>
    /// The single stdout line. camelCase so the worker's parser reads the same
    /// names whichever side of the process boundary you are on.
    /// </summary>
    private static void Emit(Report report)
    {
        Console.WriteLine(JsonSerializer.Serialize(report, ReportOpts));
    }

    private static readonly JsonSerializerOptions ReportOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
}
