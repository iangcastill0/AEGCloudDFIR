/**
 * Saving an export to disk as ONE folder, rather than as N loose files.
 *
 * The problem this solves: a browser cannot create a folder from a download.
 * Both the HTML `download` attribute and a `Content-Disposition` filename have
 * their path separators stripped, so no naming scheme groups the parts. A
 * 130 GiB export is 65 files landing loose in ~/Downloads, and the presigned
 * URLs expire in 300 seconds, so they cannot even all be clicked in time.
 *
 * Two ways out, and which one is right depends on size:
 *
 *  - Small: the File System Access API. The page asks for a directory, creates
 *    a subfolder and streams each part into it. Chromium only.
 *  - Large: a generated script. It resumes a broken part instead of starting
 *    over, re-signs URLs as it goes, and does not need a browser tab to stay
 *    open and awake for hours. This is the honest answer at 65 parts, on every
 *    browser.
 */
import { exportDownloadRefreshResponse } from '@aeg-clouddfir/contracts';

export interface DownloadPart {
  partNumber: number;
  filename: string;
  sizeBytes: number | null;
  sha256: string | null;
  url: string;
}

export interface DownloadPlanInput {
  exportId: string;
  folderName: string;
  manifestUrl: string;
  manifestSha256: string;
  parts: DownloadPart[];
  downloadToken: string;
  apiBaseUrl: string;
}

/**
 * Past these, a browser tab is the wrong tool.
 *
 * Not arbitrary. Every part of a browser save has to survive in one sitting:
 * the tab stays open, the machine stays awake, and a failure part-way restarts
 * that part from zero. Eight parts of 2 GiB is already ~16 GiB and tens of
 * minutes; the 130 GiB export that prompted this is 65 parts and the better
 * part of a day.
 *
 * `saveExportToFolder` now re-signs expired links, so link expiry is no longer
 * one of the reasons. These thresholds are NOT raised on the back of that: what
 * they are really about is resume. The browser path cannot resume a broken part
 * and the script can, and that is the cost that grows with part size, not with
 * the length of the sitting.
 */
export const SCRIPT_PART_THRESHOLD = 8;
export const SCRIPT_BYTES_THRESHOLD = 10 * 1024 * 1024 * 1024;

export function recommendScript(parts: DownloadPart[]): boolean {
  if (parts.length > SCRIPT_PART_THRESHOLD) return true;
  const known = parts.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0);
  return known > SCRIPT_BYTES_THRESHOLD;
}

/** Chromium has the directory picker; Firefox and Safari do not. */
export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Named once, because three places write it and the README names it too. */
export const UNVERIFIABLE_PARTS_FILENAME = 'unverifiable-parts.txt';

/**
 * `sha256sum -c` / `shasum -a 256 -c` format, and NOTHING else in the file.
 *
 * Written into the folder for EVERY path, browser or script, because it is
 * what lets a recipient check the transfer without this product.
 *
 * Every line is a real `DIGEST  FILENAME` line. No comments, no header. This
 * used to write a part with no digest as a `#` comment, which is the opposite
 * of the rule the archive's own `hashlist.txt` follows — and both files get
 * checked with the same command by the same person, so they cannot disagree.
 *
 * The comment convention is the one that loses, because it is not portable.
 * Measured on macOS 27: a `#` line makes the bundled `sha256sum -c` print
 * `WARNING: 1 line is improperly formatted`, and `--strict` makes it exit 1 —
 * a transfer that was perfect, reported as a failure. `shasum -a 256 -c` skips
 * the same line without a word. One file, two answers, is not something to hand
 * a recipient who may have to explain it.
 *
 * A part with no recorded digest is NOT quietly dropped instead. It is named in
 * `unverifiable-parts.txt` and counted in README.txt, because a short hashes.txt
 * that passes `-c` looks exactly like a complete one — that is the failure this
 * whole file exists to refuse.
 */
export function buildHashesTxt(parts: DownloadPart[], manifestSha256: string): string {
  const lines = parts
    .filter((p) => p.sha256 !== null)
    .map((p) => `${String(p.sha256)}  ${p.filename}`);
  if (manifestSha256 !== '') lines.push(`${manifestSha256}  manifest.json`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * The parts `hashes.txt` cannot carry, in a file of their own.
 *
 * Prose, not checksum format, so nothing will ever try to feed it to
 * `sha256sum -c`. Empty string when every part has a digest, and the file is
 * then not written at all — an empty one reads like something went wrong.
 */
export function buildUnverifiablePartsTxt(parts: DownloadPart[]): string {
  const missing = parts.filter((p) => p.sha256 === null);
  if (missing.length === 0) return '';
  return [
    'Parts with NO recorded digest',
    '=============================',
    '',
    `${String(missing.length)} of the ${String(parts.length)} part(s) in this folder are listed`,
    'below. They are NOT in hashes.txt, because a checksum file that mixes real',
    'lines with placeholders is read differently by different tools.',
    '',
    'They downloaded, they are here, and this product cannot prove they arrived',
    'intact: it was never given their digests. This export was produced before',
    'per-part digests were recorded.',
    '',
    'To check them, extract the archives and verify the contents against',
    'hashlist.txt, which is inside the archive and covers every item.',
    '',
    ...missing.map((p) => p.filename),
    '',
  ].join('\n');
}

export function buildReadme(input: DownloadPlanInput): string {
  const unverifiable = input.parts.filter((p) => p.sha256 === null).length;
  return [
    'AEG-CloudDFIR export download',
    '=============================',
    '',
    `Export id: ${input.exportId}`,
    `Parts:     ${String(input.parts.length)}`,
    '',
    'Check the transfer before you rely on it:',
    '',
    '  macOS:   shasum -a 256 -c hashes.txt',
    '  Linux:   sha256sum -c hashes.txt',
    '  Windows: Get-Content hashes.txt | ForEach-Object {',
    '             $h,$f = $_ -split "\\s+",2',
    '             if ((Get-FileHash $f -Algorithm SHA256).Hash -ieq $h) { "OK $f" }',
    '             else { "FAILED $f" } }',
    '',
    'That checks the PARTS arrived intact. It does not check the contents —',
    'for that, extract the archives and follow README.txt inside, which',
    'verifies every item against hashlist.txt.',
    '',
    ...(unverifiable > 0
      ? [
          `WARNING: ${String(unverifiable)} of the ${String(input.parts.length)} part(s) here have no recorded`,
          'digest, because this export was produced before per-part digests were',
          `recorded. They are NOT in hashes.txt — they are named in`,
          `${UNVERIFIABLE_PARTS_FILENAME}, so the command above will report OK and`,
          'still not have checked them. Extract those parts and verify the contents',
          'against hashlist.txt instead.',
          '',
        ]
      : []),
  ].join('\n');
}

/**
 * A bash script that downloads every part into a folder.
 *
 * It asks the API for fresh URLs rather than carrying presigned ones: those
 * expire in 300 seconds and this download takes hours. `curl -C -` resumes a
 * part that broke rather than restarting a 2 GiB transfer.
 *
 * The token is a secret. It reaches this one export, read-only, and expires —
 * but while it lives, anyone holding the script can download this evidence.
 */
/**
 * Folder name safe to place in a shell script.
 *
 * The API already does this in downloadFolderName. Doing it again here means
 * a name that skipped that helper still cannot become a command. Single
 * quotes below do not expand, and this set cannot break out of them.
 */
function scriptFolderName(name: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return safe === '' ? 'export' : safe;
}

export function buildBashScript(input: DownloadPlanInput): string {
  // filename<TAB>bytes, for every part whose size this product recorded. It is
  // what lets a re-run tell a finished part from a half one.
  const sizes = input.parts
    .filter((p) => p.sizeBytes !== null)
    .map((p) => `${p.filename}\t${String(p.sizeBytes)}`)
    .join('\n');

  // Only when there is something to say. Decided here, at generation time,
  // because the script already knows which parts had digests.
  const unverifiable = buildUnverifiablePartsTxt(input.parts);
  const unverifiableBlock =
    unverifiable === ''
      ? ''
      : `
cat > ${UNVERIFIABLE_PARTS_FILENAME} <<'CDFIR_UNVERIFIABLE_EOF'
${unverifiable.trimEnd()}
CDFIR_UNVERIFIABLE_EOF
`;

  return `#!/usr/bin/env bash
# Download an AEG-CloudDFIR export into one folder.
#
#   chmod +x download-export.sh && ./download-export.sh
#
# Resumable: re-run it and it picks up where it stopped.
#
# SECURITY: the token below downloads this one export until it expires.
# Treat this file as sensitive and delete it when the download is done.
set -euo pipefail

API="${input.apiBaseUrl}"
EXPORT_ID="${input.exportId}"
TOKEN="${input.downloadToken}"
DIR='${scriptFolderName(input.folderName)}'
LIST=".cdfir-urls.tsv"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required (to read the URL list)" >&2; exit 1; }

mkdir -p "$DIR"
cd "$DIR"

# Verification material first, from figures this product already holds. A
# transfer that stops half way still leaves a folder someone can check.
cat > hashes.txt <<'CDFIR_HASHES_EOF'
${buildHashesTxt(input.parts, input.manifestSha256).trimEnd()}
CDFIR_HASHES_EOF
${unverifiableBlock}
cat > README.txt <<'CDFIR_README_EOF'
${buildReadme(input).trimEnd()}
CDFIR_README_EOF

# Sizes recorded when this script was generated.
SIZES=$(cat <<'CDFIR_SIZES_EOF'
${sizes}
CDFIR_SIZES_EOF
)

# Is this file already here in full?
#
# Asking curl to resume a file that is already complete makes the server answer
# 416, which looks like a failure and would stop the script on a re-run. A file
# with no recorded size cannot be told apart from a short one, so it is deleted
# and fetched again rather than kept and trusted.
prepare() {
  name="$1"
  want=$(printf '%s\\n' "$SIZES" | awk -F'\\t' -v n="$name" '$1 == n { print $2 }')
  if [ -z "$want" ]; then
    rm -f "$name"
    return 1
  fi
  [ -f "$name" ] || return 1
  have=$(wc -c < "$name" | tr -d ' ')
  [ "$have" = "$want" ]
}

# Presigned URLs last minutes, so they are fetched fresh rather than baked in.
refresh_urls() {
  curl -fsS -X POST "$API/api/v1/exports/$EXPORT_ID/download/urls" \\
    -H "Authorization: Bearer $TOKEN" \\
  | python3 -c '
import sys, json
d = json.load(sys.stdin)
for p in d["parts"]:
    print("%s\\t%s" % (p["filename"], p["url"]))
print("manifest.json\\t%s" % d["manifestUrl"])
'
}

echo "Fetching download URLs..."
refresh_urls > "$LIST"
total=$(wc -l < "$LIST" | tr -d ' ')
echo "$total file(s) to fetch into $DIR/"

n=0
while IFS=$'\\t' read -r name url; do
  n=$((n + 1))
  if prepare "$name"; then
    echo "[$n/$total] $name (already complete)"
    continue
  fi
  echo "[$n/$total] $name"
  # -C - resumes; a 2 GiB part that broke does not start over.
  # Two tries: the first may fail on a URL that expired mid-run, so refresh.
  if ! curl -fsSL -C - -o "$name" "$url"; then
    echo "  url expired or failed, refreshing..."
    # A DIFFERENT file: this loop is reading "$LIST" on stdin, and rewriting a
    # file while an open descriptor is part way through it truncates the read.
    refresh_urls > "$LIST.new"
    url=$(grep -F "$name"$'\\t' "$LIST.new" | head -1 | cut -f2)
    curl -fsSL -C - -o "$name" "$url"
  fi
done < "$LIST"

rm -f "$LIST" "$LIST.new"
echo
echo "Done. Verify what arrived:"
echo "  cd $DIR && shasum -a 256 -c hashes.txt   # macOS"
echo "  cd $DIR && sha256sum -c hashes.txt       # Linux"
`;
}

/** The same thing for Windows, where PowerShell parses JSON natively. */
export function buildPowerShellScript(input: DownloadPlanInput): string {
  const unverifiable = buildUnverifiablePartsTxt(input.parts);
  const unverifiableBlock =
    unverifiable === ''
      ? ''
      : `
Set-Content -Path ${UNVERIFIABLE_PARTS_FILENAME} -Encoding utf8 -Value @'
${unverifiable.trimEnd()}
'@
`;

  return `# Download an AEG-CloudDFIR export into one folder.
#
#   powershell -ExecutionPolicy Bypass -File download-export.ps1
#
# SECURITY: the token below downloads this one export until it expires.
# Treat this file as sensitive and delete it when the download is done.
$ErrorActionPreference = "Stop"

$Api      = "${input.apiBaseUrl}"
$ExportId = "${input.exportId}"
$Token    = "${input.downloadToken}"
$Dir      = '${scriptFolderName(input.folderName)}'

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir

# Verification material first, from figures this product already holds. A
# transfer that stops half way still leaves a folder someone can check.
Set-Content -Path hashes.txt -Encoding utf8 -Value @'
${buildHashesTxt(input.parts, input.manifestSha256).trimEnd()}
'@
${unverifiableBlock}
Set-Content -Path README.txt -Encoding utf8 -Value @'
${buildReadme(input).trimEnd()}
'@

# Sizes recorded when this script was generated, so a re-run can tell a
# finished part from a half one.
$Sizes = @{
${input.parts
  .filter((p) => p.sizeBytes !== null)
  .map((p) => `  "${p.filename}" = ${String(p.sizeBytes)}`)
  .join('\n')}
}

function Get-Urls {
  # Presigned URLs last minutes, so they are fetched fresh rather than baked in.
  $r = Invoke-RestMethod -Method Post -Uri "$Api/api/v1/exports/$ExportId/download/urls" \`
       -Headers @{ Authorization = "Bearer $Token" }
  $list = @()
  foreach ($p in $r.parts) { $list += [pscustomobject]@{ Name = $p.filename; Url = $p.url } }
  $list += [pscustomobject]@{ Name = "manifest.json"; Url = $r.manifestUrl }
  return $list
}

Write-Host "Fetching download URLs..."
$files = Get-Urls
$n = 0
foreach ($f in $files) {
  $n++
  # "It is already here" is not the same as "it arrived in full". A part that
  # stopped half way is a short file, and skipping it because the name exists
  # would hand over truncated evidence that still passes a glance at the
  # folder. Only a byte-exact match counts as done; anything else starts over,
  # because Invoke-WebRequest cannot resume the way curl can.
  if ((Test-Path $f.Name) -and $Sizes.ContainsKey($f.Name) -and
      ((Get-Item $f.Name).Length -eq $Sizes[$f.Name])) {
    Write-Host "[$n/$($files.Count)] $($f.Name) (already complete)"
    continue
  }
  Write-Host "[$n/$($files.Count)] $($f.Name)"
  Remove-Item -Force -ErrorAction SilentlyContinue $f.Name
  try {
    Invoke-WebRequest -Uri $f.Url -OutFile $f.Name
  } catch {
    Write-Host "  url expired or failed, refreshing..."
    $fresh = Get-Urls | Where-Object { $_.Name -eq $f.Name }
    Invoke-WebRequest -Uri $fresh.Url -OutFile $f.Name
  }
}

Write-Host ""
Write-Host "Done. Verify what arrived:"
Write-Host "  Get-Content hashes.txt | ForEach-Object { \\$h,\\$fn = \\$_ -split '\\s+',2; if ((Get-FileHash \\$fn -Algorithm SHA256).Hash -ieq \\$h) { \\"OK \\$fn\\" } else { \\"FAILED \\$fn\\" } }"
`;
}

export interface FolderSaveProgress {
  partNumber: number;
  filename: string;
  done: number;
  total: number;
}

/**
 * What S3 answers with when a presigned URL has run out of time. 403 is the one
 * it actually sends; 401 is here because a gateway in front of it may translate.
 * Anything else is a real failure and must not be retried — a 404 means the
 * object is gone, and asking again politely will not bring it back.
 */
const EXPIRED_URL_STATUS = new Set([401, 403]);

/** The API path the scripts call, in one place so all three paths agree. */
export function refreshUrlsPath(exportId: string): string {
  return `/api/v1/exports/${exportId}/download/urls`;
}

interface FreshUrls {
  manifestUrl: string;
  byFilename: Map<string, string>;
}

/**
 * Ask the API to re-sign every URL for this export.
 *
 * The same call the generated scripts make, with the same credential: the
 * scoped download token in an `Authorization` header. `credentials: 'omit'` is
 * deliberate and load-bearing. This endpoint is the one route allowed past the
 * API's global CSRF guard, and the reason that is safe is that it authenticates
 * by the Bearer token ALONE. Sending cookies here would make the browser path
 * quietly depend on the thing the exemption assumes is absent.
 */
async function fetchFreshUrls(input: DownloadPlanInput): Promise<FreshUrls> {
  const response = await fetch(`${input.apiBaseUrl}${refreshUrlsPath(input.exportId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.downloadToken}`, Accept: 'application/json' },
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new Error(`the API refused to re-sign the links (HTTP ${String(response.status)})`);
  }
  // Parsed with the schema the API is tested against, so a shape change is
  // caught here rather than as an undefined URL half way through a save.
  const body = exportDownloadRefreshResponse.parse(await response.json());
  return {
    manifestUrl: body.manifestUrl,
    byFilename: new Map(body.parts.map((p) => [p.filename, p.url])),
  };
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stream every part into one folder the user picks. Chromium only.
 *
 * Sequential, not parallel: these are 2 GiB files, and several at once
 * competes for the same link while making the progress report meaningless.
 *
 * Nothing is hashed here. `crypto.subtle.digest` needs the whole buffer, and
 * holding 2 GiB in memory to check it would trade a download problem for an
 * out-of-memory one. `hashes.txt` goes into the folder instead, so the check
 * is one command and does not depend on this product being open.
 *
 * Links are re-signed as it goes, the same way the scripts do. Being sequential
 * is exactly what makes that necessary: expiry is checked when a request
 * STARTS, so one slow part is fine, but a part that takes over
 * `CDFIR_S3_PRESIGN_TTL_SECONDS` (300) hands the NEXT part a dead URL. Before
 * this, a save that crossed five minutes — two 2 GiB parts on an ordinary
 * connection — stopped with a 403 and no way forward but starting again.
 */
export async function saveExportToFolder(
  input: DownloadPlanInput,
  onProgress: (p: FolderSaveProgress) => void,
): Promise<void> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  const root = await picker({ mode: 'readwrite' });
  const folder = await root.getDirectoryHandle(input.folderName, { create: true });

  const write = async (name: string, body: ReadableStream<Uint8Array> | string): Promise<void> => {
    const handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    if (typeof body === 'string') {
      await writable.write(body);
      await writable.close();
      return;
    }
    await body.pipeTo(writable);
  };

  // The live URLs, replaced wholesale by a refresh — the same thing the shell
  // script does with its URL list. One refresh re-signs every part, so keeping
  // only the one that failed would cost a 403 and a round trip on each of the
  // parts still to come.
  const urls = new Map(input.parts.map((p) => [p.filename, p.url]));
  let manifestUrl = input.manifestUrl;

  const refresh = async (): Promise<void> => {
    const fresh = await fetchFreshUrls(input);
    for (const [filename, url] of fresh.byFilename) urls.set(filename, url);
    manifestUrl = fresh.manifestUrl;
  };

  /**
   * Fetch one file, and if its link had expired, re-sign and try ONCE more.
   *
   * One retry, deliberately. A loop would turn a dead token into a save that
   * never finishes and never says why. The second failure throws and names the
   * file, and says the folder is incomplete, because a folder quietly missing a
   * part is the outcome this product must never produce.
   */
  const fetchWithRefresh = async (name: string, urlNow: () => string): Promise<Response> => {
    const first = await fetch(urlNow());
    if (first.ok && first.body !== null) return first;
    if (!EXPIRED_URL_STATUS.has(first.status)) {
      throw new Error(`could not fetch ${name} (HTTP ${String(first.status)})`);
    }

    try {
      await refresh();
    } catch (err) {
      throw new Error(
        `could not fetch ${name}: its download link expired and re-signing failed (${reasonFor(err)}). This folder is INCOMPLETE.`,
        { cause: err },
      );
    }

    const second = await fetch(urlNow());
    if (second.ok && second.body !== null) return second;
    throw new Error(
      `could not fetch ${name} (HTTP ${String(second.status)}) on a freshly signed link. This folder is INCOMPLETE.`,
    );
  };

  const total = input.parts.length + 1;
  let done = 0;

  for (const part of input.parts) {
    onProgress({ partNumber: part.partNumber, filename: part.filename, done, total });
    const response = await fetchWithRefresh(part.filename, () => urls.get(part.filename) ?? '');
    await write(part.filename, response.body as ReadableStream<Uint8Array>);
    done += 1;
  }

  onProgress({ partNumber: 0, filename: 'manifest.json', done, total });
  // Raised, not swallowed. hashes.txt names manifest.json and the README says
  // the folder is complete, so a manifest that quietly failed to arrive would
  // leave a folder that reports success and cannot be verified. It is fetched
  // last, so it is the MOST likely link to have expired.
  const manifest = await fetchWithRefresh('manifest.json', () => manifestUrl);
  await write('manifest.json', manifest.body as ReadableStream<Uint8Array>);
  done += 1;

  // Verification material last, so a folder that has it is a folder that is
  // complete.
  await write('hashes.txt', buildHashesTxt(input.parts, input.manifestSha256));
  const unverifiable = buildUnverifiablePartsTxt(input.parts);
  if (unverifiable !== '') await write(UNVERIFIABLE_PARTS_FILENAME, unverifiable);
  await write('README.txt', buildReadme(input));
  onProgress({ partNumber: 0, filename: '', done, total });
}
