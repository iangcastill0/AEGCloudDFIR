import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import {
  Sha256Stream,
  archivePartFilename,
  canonicalJson,
  derivativeTypeFor,
  sanitizeFilename,
} from '@aeg-clouddfir/evidence';
import { csvEscape } from '@aeg-clouddfir/production';
import { sanitizeError, type WorkerContext } from '../context.js';
import { buildPst, type PstPart, type PstbResult } from './pstb.js';

/**
 * PST export.
 *
 * The one thing to understand before changing anything here: **a PST holds
 * re-encoded bytes that hash to nothing anyone recorded.**
 *
 * The SHA-256 we hold for a message is the digest of the native `.eml` that was
 * acquired. The PST contains Outlook's own encoding of that message, so its
 * bytes are different, and their digest was never written down by anybody. It is
 * worse than that: this writer is not deterministic. Exporting the same 480
 * messages twice produced two PST files with different SHA-256 (measured
 * 2026-09-24), so even "the same export should hash the same" is not true. And
 * saving a message back out of Outlook produces different bytes again.
 *
 * So a PST export ships the native digests, structurally, not optionally:
 * `native-digests.csv` and `manifest.json` both carry them, and
 * `assertNativeDigestsPresent` fails the export if they are missing. A PST
 * handed over on its own is unverifiable evidence, and this product exists to
 * not do that.
 */

/**
 * The derivative prefix PST parts live under.
 *
 * Read from `derivativeTypeFor` rather than written here, because the API's key
 * fallback and the backfill script derive it the same way. A second copy of the
 * string is a second chance to look in the wrong prefix.
 */
const PST_DERIVATIVE_TYPE = derivativeTypeFor('pst');

export interface PstExportItem {
  evidenceItemId: string;
  /** Recorded digest of the acquired native `.eml`. The only digest that means anything. */
  sha256: string;
  size: number;
  subject: string;
  folderPath: string;
  custodianEmail: string;
  collectionId: string;
  /** Where the native bytes live in object storage. */
  storageClass: 'evidence' | 'quarantine';
  objectKey: string;
  receivedAt: string | null;
}

export interface PstExportOptions {
  binPath: string;
  scratchRoot: string;
  timeoutMs: number;
  spoolThresholdBytes: number;
  partBytes: number;
  storeDisplayName: string;
  /** Test seam: replaces the child process entirely. */
  runPst?: (jobPath: string) => Promise<PstbResult>;
  /**
   * Test seams for the two places this module touches local disk. Production
   * leaves both unset and gets `node:fs`.
   */
  createWriteStreamFn?: (path: string) => Writable;
  createReadStreamFn?: (path: string) => Readable;
  /**
   * Test seam for the digest file builder.
   *
   * It exists for one reason: without it there is no way to check that
   * `assertNativeDigestsPresent` is actually WIRED IN. Deleting the call left
   * every other test green, because the other route to "no digests" — items with
   * no preserved native bytes — fails earlier for a different reason. A guard
   * nothing exercises is a comment.
   */
  buildDigestCsvFn?: (items: readonly PstExportItem[]) => string;
  /**
   * Items that never went into the PST for a reason other than a bad native
   * hash — typically a selected PDF or Drive file, which a mailbox file cannot
   * hold. They are merged into exceptions.csv / manifest.exceptions so a
   * recipient can see what was left out. Hash-verification failures are still
   * recorded separately inside this function.
   */
  extraExceptions?: readonly { evidenceItemId: string; error: string }[];
}

export interface PstExportOutcome {
  parts: { partNumber: number; objectKey: string; sha256: string; sizeBytes: number }[];
  itemCount: number;
  failedCount: number;
  totalBytes: number;
  manifestSha256: string;
  outputPrefix: string;
  messagesAdded: number;
  peakWorkingSetMiB: number;
}

/**
 * A PST export must carry the native digests or it must not exist.
 *
 * Exported and called from one place, because "we meant to write them" is how
 * this becomes optional again. An export whose PST is fine and whose digest file
 * is missing looks completely normal to a recipient, and there is nothing in the
 * PST that would ever tell them.
 */
export function assertNativeDigestsPresent(
  items: readonly Pick<PstExportItem, 'evidenceItemId' | 'sha256'>[],
  digestCsv: string,
): void {
  const withDigest = items.filter((i) => i.sha256 !== '');
  if (withDigest.length === 0) {
    throw new Error(
      'refusing to write a PST export with no native .eml digests: nothing in a PST can be verified without them',
    );
  }
  const lines = digestCsv.trimEnd().split('\n');
  // Header plus one row per item that has a digest. Counted, not trusted: a
  // truncated digest file is exactly as unverifiable as a missing one.
  if (lines.length !== withDigest.length + 1) {
    throw new Error(
      `native digest file is incomplete: ${String(lines.length - 1)} row(s) for ` +
        `${String(withDigest.length)} item(s) with a recorded digest`,
    );
  }
  for (const item of withDigest) {
    if (!digestCsv.includes(item.sha256)) {
      throw new Error(`native digest file is missing the digest for item ${item.evidenceItemId}`);
    }
  }
}

/** `sha256sum -c` format over the native `.eml` files, and nothing else in it. */
export function buildNativeDigestCsv(items: readonly PstExportItem[]): string {
  const rows = [
    ['evidenceItemId', 'sha256', 'sizeBytes', 'subject', 'folderPath', 'custodianEmail']
      .map((c) => csvEscape(c))
      .join(','),
    ...items
      .filter((i) => i.sha256 !== '')
      .map((i) =>
        [i.evidenceItemId, i.sha256, String(i.size), i.subject, i.folderPath, i.custodianEmail]
          .map((v) => csvEscape(v))
          .join(','),
      ),
  ];
  return `${rows.join('\r\n')}\r\n`;
}

/**
 * What a recipient can and cannot check, written out in the export itself.
 *
 * Not a link to a policy page. Whoever opens this folder in two years has this
 * file and nothing else, and the honest limits have to survive that long.
 */
export function buildPstReadme(
  parts: readonly PstPart[],
  itemCount: number,
  digestedCount: number,
): string {
  return [
    'AEG-CloudDFIR PST export',
    '========================',
    '',
    'READ THIS FIRST: the PST is a reconstruction, not the evidence.',
    '-------------------------------------------------------------',
    '',
    `This export covers ${String(itemCount)} message(s), written into`,
    `${String(parts.length)} PST file(s).`,
    '',
    'Each message was re-encoded into Outlook PST format. The bytes inside the',
    'PST are NOT the bytes that were collected, and their hashes were never',
    'recorded by anyone. Hashing the PST cannot tell you a message is intact.',
    '',
    'The PST writer is also not reproducible: exporting the same messages again',
    'produces a PST with a different SHA-256. So do not treat a changed PST',
    'hash as evidence of tampering, and do not treat a matching one as proof of',
    'anything beyond the transfer.',
    '',
    'What you CAN verify',
    '-------------------',
    '  1. That these files arrived intact. hashes.txt in the download folder',
    '     lists the SHA-256 of each PST file as it was uploaded. Run',
    '     `sha256sum -c hashes.txt`.',
    `  2. That message content is unaltered, using native-digests.csv. It holds`,
    `     the SHA-256 of the original .eml for ${String(digestedCount)} of the`,
    `     ${String(itemCount)} message(s). Export the message from Outlook as`,
    '     .eml and the hash will NOT match — Outlook re-encodes on the way out',
    '     too. To check content, request the native export of the same',
    '     selection: those files hash to the values in native-digests.csv.',
    '  3. manifest.json is canonical JSON and lists every message, its native',
    '     digest, and which PST file it went into.',
    '  4. exceptions.csv lists any selected item that is not in the PST: a',
    '     native that failed hash verification, or a non-email (a mailbox file',
    '     cannot hold a PDF or a Drive file).',
    '',
    'What you CANNOT verify',
    '----------------------',
    '  * Nothing inside the PST can be hash-verified against collection.',
    '  * These properties are DERIVED by this product, not collected:',
    '      - folder placement (a message with no folder is filed under "Unfiled")',
    '      - delivery and submit times, when the source message had no Date header',
    '      - message flags (every message is marked read)',
    '      - display-name fields built from the address headers',
    '      - one marker named property, PS_COMMON 0x8580, set to',
    '        "aeg-clouddfir-export". The PST format requires at least one named',
    '        property or the file cannot be opened at all; it carries no evidence',
    '        and is not present in the collected message.',
    '  * BCC recipients are only present if the acquired message carried them.',
    '',
    'Each PST file is complete on its own',
    '------------------------------------',
    'These are separate mailbox files, NOT volumes of one split archive. Open',
    'any one of them in Outlook without the others. There is nothing to rejoin.',
    ...parts.map((p) => `  ${p.name}  ${String(p.bytes)} bytes`),
    '',
    TRUTHFULNESS_NOTICES.pstExport,
    '',
    TRUTHFULNESS_NOTICES.defensibility,
    '',
  ].join('\n');
}

/**
 * Assemble a PST export.
 *
 * Shape of the work: pull every native down to a scratch directory, hand the
 * writer a job file, then upload each finished PST. The natives have to be on
 * local disk because the writer is a child process that reads files, and
 * because MIME parsing needs to seek.
 *
 * Disk, and why not `/tmp`: `scratchRoot` is a real named volume. The worker's
 * `/tmp` is a small tmpfs, so a multi-gigabyte PST there either fills RAM or
 * lands on the container's writable layer. That disk filling once crashed
 * PostgreSQL, which then could not restart because replaying its log also
 * needed space.
 *
 * Concurrency: the `exportRun` queue is 1 (see `workers.ts`) and this function
 * relies on that. One PST build can hold a multi-hundred-megabyte working set,
 * it writes gigabytes to the scratch volume, and two at once would double both
 * on a host with 31 GB shared with staging, Authentik and ClamAV.
 */
export async function runPstExport(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  items: readonly PstExportItem[],
  opts: PstExportOptions,
): Promise<PstExportOutcome> {
  if (items.length === 0) {
    throw new Error('refusing to build a PST for an empty selection');
  }

  const workDir = join(opts.scratchRoot, exportId);
  const nativeDir = join(workDir, 'native');
  const outDir = join(workDir, 'out');
  const spoolDir = join(workDir, 'spool');
  const openWrite = opts.createWriteStreamFn ?? createWriteStream;
  const openRead = opts.createReadStreamFn ?? createReadStream;

  try {
    await mkdir(nativeDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(spoolDir, { recursive: true });

    // --- stage the natives, verifying each one on the way down -------------
    const jobMessages: { path: string; folderPath: string; receivedUtc: string | null }[] = [];
    const staged: PstExportItem[] = [];
    const failures: { evidenceItemId: string; error: string }[] = [];

    for (const item of items) {
      if (item.objectKey === '' || item.sha256 === '') {
        failures.push({ evidenceItemId: item.evidenceItemId, error: 'no preserved native bytes' });
        continue;
      }
      // Sequential, not parallel: the point of staging is bounded disk and
      // memory, and the export lane is one worker anyway.
      const localPath = join(nativeDir, `${item.evidenceItemId}.eml`);
      try {
        const source = await ctx.store.getStream(item.storageClass, item.objectKey);
        const hasher = new Sha256Stream();
        await pipeline(source, hasher, openWrite(localPath));
        const actual = hasher.digestHex();
        if (actual !== item.sha256) {
          // The native did not hash to its recorded digest, so it does not go
          // into the PST at all. Unlike the zip path there is no way to record
          // a mismatch inside a PST that a reader would ever see, so the only
          // honest handling is to leave it out and name it in exceptions.csv.
          failures.push({
            evidenceItemId: item.evidenceItemId,
            error: `sha256 mismatch: expected ${item.sha256}, streamed ${actual}`,
          });
          continue;
        }
      } catch (err) {
        failures.push({ evidenceItemId: item.evidenceItemId, error: sanitizeError(err) });
        continue;
      }
      staged.push(item);
      jobMessages.push({
        path: localPath,
        folderPath: item.folderPath,
        receivedUtc: item.receivedAt,
      });
    }

    if (staged.length === 0) {
      throw new Error(
        `every one of the ${String(items.length)} selected item(s) failed native verification; ` +
          `no PST was written`,
      );
    }

    // --- the digests, built and checked BEFORE the PST is written ----------
    // Deliberately before: if this cannot be produced there is no reason to
    // spend hours writing a PST nobody can verify.
    const nativeDigestCsv = (opts.buildDigestCsvFn ?? buildNativeDigestCsv)(staged);
    assertNativeDigestsPresent(staged, nativeDigestCsv);

    // --- run the writer ---------------------------------------------------
    const jobPath = join(workDir, 'job.json');
    await writeFile(
      jobPath,
      JSON.stringify({
        outPath: join(outDir, 'export.pst'),
        maxBytesPerPart: opts.partBytes,
        storeDisplayName: opts.storeDisplayName,
        spoolDir,
        spoolThresholdBytes: opts.spoolThresholdBytes,
        messages: jobMessages,
      }),
      'utf8',
    );

    const run =
      opts.runPst ??
      ((p: string) => buildPst({ binPath: opts.binPath, jobPath: p, timeoutMs: opts.timeoutMs }));
    const built = await run(jobPath);
    if (!built.ok) throw new Error(built.reason);

    ctx.log.info(
      {
        exportId,
        parts: built.parts.length,
        messagesAdded: built.messagesAdded,
        peakWorkingSetMiB: built.peakWorkingSetMiB,
        spooledAttachments: built.spooledAttachments,
      },
      'pst export: writer finished',
    );

    if (built.messagesAdded !== staged.length) {
      throw new Error(
        `PST writer added ${String(built.messagesAdded)} message(s) but ${String(staged.length)} ` +
          `were staged; refusing to ship an export that is quietly short`,
      );
    }

    // --- upload each part, recording the digest of the file as uploaded ----
    const uploaded: PstExportOutcome['parts'] = [];
    let totalBytes = 0;
    let outputPrefix = '';
    for (const [index, part] of built.parts.entries()) {
      const partNumber = index + 1;
      const filename = pstPartFilename(partNumber);
      const body = new PassThrough();
      const put = ctx.store.putDerivative(
        tenantId,
        exportId,
        PST_DERIVATIVE_TYPE,
        partNumber,
        filename,
        body,
        'application/vnd.ms-outlook',
      );
      await pipeline(openRead(part.path), body);
      const done = await put;
      uploaded.push({
        partNumber,
        objectKey: done.objectKey,
        sha256: done.sha256,
        sizeBytes: done.size,
      });
      totalBytes += done.size;
      if (outputPrefix === '') outputPrefix = done.objectKey;
    }

    // --- the paperwork ----------------------------------------------------
    const exceptions = [...(opts.extraExceptions ?? []), ...failures];
    const manifestJson = canonicalJson({
      schema: 'cdfir.export.pst.manifest.v1',
      exportId,
      generatedAt: new Date().toISOString(),
      kind: 'pst',
      /**
       * Stated in the manifest, not only in the README, because a tool reading
       * the manifest must not be able to conclude the PST is verifiable.
       */
      reconstruction: true,
      pstBytesAreHashVerifiable: false,
      pstWriterIsReproducible: false,
      derivedProperties: [
        'folderPath',
        'deliveryTimeUtc',
        'submitTimeUtc',
        'messageFlags',
        'displayNameFields',
        'namedProperty:PS_COMMON:0x8580',
      ],
      notice: TRUTHFULNESS_NOTICES.pstExport,
      itemCount: staged.length,
      failedCount: exceptions.length,
      parts: uploaded.map((p) => ({
        partNumber: p.partNumber,
        filename: pstPartFilename(p.partNumber),
        sha256: p.sha256,
        sizeBytes: p.sizeBytes,
        /** Each part is a whole PST. Nothing has to be rejoined. */
        independentlyOpenable: true,
      })),
      items: staged.map((i) => ({
        evidenceItemId: i.evidenceItemId,
        nativeSha256: i.sha256,
        nativeSizeBytes: i.size,
        subject: i.subject,
        folderPath: i.folderPath === '' ? 'Unfiled' : i.folderPath,
        custodianEmail: i.custodianEmail,
        collectionId: i.collectionId,
      })),
      exceptions,
    });

    const readme = buildPstReadme(
      built.parts,
      staged.length,
      staged.filter((i) => i.sha256 !== '').length,
    );
    const exceptionsCsv = [
      ['evidenceItemId', 'error'].map((c) => csvEscape(c)).join(','),
      ...exceptions.map((f) => [f.evidenceItemId, f.error].map((v) => csvEscape(v)).join(',')),
    ].join('\r\n');

    // Sidecars go to object storage beside the parts, so the download plumbing
    // picks them up the same way it picks up manifest.json for a zip export.
    const manifestPut = await ctx.store.putDerivative(
      tenantId,
      exportId,
      'export-manifest',
      1,
      'manifest.json',
      Buffer.from(manifestJson, 'utf8'),
      'application/json',
    );
    await ctx.store.putDerivative(
      tenantId,
      exportId,
      PST_DERIVATIVE_TYPE,
      0,
      'native-digests.csv',
      Buffer.from(nativeDigestCsv, 'utf8'),
      'text/csv; charset=utf-8',
    );
    await ctx.store.putDerivative(
      tenantId,
      exportId,
      PST_DERIVATIVE_TYPE,
      0,
      'README.txt',
      Buffer.from(readme, 'utf8'),
      'text/plain; charset=utf-8',
    );
    await ctx.store.putDerivative(
      tenantId,
      exportId,
      PST_DERIVATIVE_TYPE,
      0,
      'exceptions.csv',
      Buffer.from(`${exceptionsCsv}\r\n`, 'utf8'),
      'text/csv; charset=utf-8',
    );

    return {
      parts: uploaded,
      itemCount: staged.length,
      failedCount: failures.length,
      totalBytes,
      manifestSha256: manifestPut.sha256,
      outputPrefix,
      messagesAdded: built.messagesAdded,
      peakWorkingSetMiB: built.peakWorkingSetMiB,
    };
  } finally {
    // Always, on every path. The staged natives and the finished PSTs together
    // are twice the size of the export, on the same disk as PostgreSQL.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Part filenames sort in part order and are the same wherever they are built.
 *
 * Delegates to `archivePartFilename` rather than formatting its own string. The
 * worker writes these names and the API signs them into download URLs, so two
 * implementations would be two chances to disagree — and the symptom would be a
 * download 404 on a part that is sitting right there in the bucket.
 */
export function pstPartFilename(partNumber: number): string {
  return archivePartFilename('pst', partNumber);
}

/**
 * A display name Outlook will show, derived from the export's own name.
 *
 * The blank check is on the INPUT, not on the sanitised output: `sanitizeFilename`
 * answers an empty string with the placeholder `'file'`, which is a sensible
 * filename and a nonsense name for a mailbox. A recipient opening a PST called
 * "file" learns nothing about which export it is.
 */
export function pstStoreDisplayName(exportName: string): string {
  if (exportName.trim() === '') return 'Personal Folders';
  const safe = sanitizeFilename(exportName).slice(0, 60).trim();
  return safe === '' || safe === 'file' ? 'Personal Folders' : safe;
}
