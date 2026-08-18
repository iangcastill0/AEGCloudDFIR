import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * LibreOffice text-extraction fallback.
 *
 * Tika refuses some formats outright — Publisher, Visio, WordPerfect — and the
 * worker image already ships LibreOffice, which can usually open them. Trying it
 * before recording an unsupported_item exception recovers documents that would
 * otherwise be collected and preserved but never searchable.
 *
 * The route is deliberately soffice -> PDF -> pdftotext, not a direct text
 * conversion. `--convert-to txt:Text` uses a WRITER filter, so for a document
 * that imports into Draw (Publisher, Visio) LibreOffice reports success —
 * "convert ... using filter : Text" — and writes no file at all. Verified
 * against a real .pub: the text route produced nothing while the PDF route
 * produced a document pdftotext could read.
 *
 * This is a best-effort second attempt. Every failure path returns a reason
 * rather than throwing, because the caller's fallback is to record the honest
 * exception it would have recorded anyway; a crash here would turn a
 * non-extractable attachment into a failed job.
 */

/** Formats worth a second attempt: ones LibreOffice opens and Tika commonly declines. */
const CONVERTIBLE = new Map<string, string>([
  ['application/x-mspublisher', 'pub'],
  ['application/vnd.ms-publisher', 'pub'],
  ['application/vnd.visio', 'vsd'],
  ['application/x-visio', 'vsd'],
  ['application/wordperfect', 'wpd'],
  ['application/x-wordperfect', 'wpd'],
  ['application/vnd.wordperfect', 'wpd'],
  ['application/x-mswrite', 'wri'],
  ['application/vnd.lotus-1-2-3', '123'],
  ['application/vnd.ms-works', 'wps'],
  ['application/x-abiword', 'abw'],
  ['application/x-starwriter', 'sdw'],
]);

/** Extensions accepted when the MIME type is generic or absent. */
const CONVERTIBLE_EXTENSIONS = new Set([
  'pub',
  'vsd',
  'vsdx',
  'wpd',
  'wri',
  '123',
  'wps',
  'abw',
  'sdw',
  'sdc',
]);

export type SofficeResult = { ok: true; text: string } | { ok: false; reason: string };

export interface SofficeOptions {
  timeoutMs: number;
  /** Cap on the text read back, mirroring the Tika path's limit. */
  maxTextBytes: number;
  /** Test seam. Production uses node:child_process spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Whether a second attempt is worth the process spawn.
 *
 * Deliberately narrow. Running LibreOffice against every format Tika rejects
 * would spend seconds per item on things it cannot open either — images,
 * archives, executables — and each spawn is far more expensive than the HTTP
 * call that already failed.
 */
export function isConvertible(mimeType: string, filename: string): boolean {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (CONVERTIBLE.has(mime)) return true;
  const ext = extensionOf(filename);
  return ext !== '' && CONVERTIBLE_EXTENSIONS.has(ext);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Pick the extension soffice needs to choose an import filter. */
function inputExtension(mimeType: string, filename: string): string {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return CONVERTIBLE.get(mime) ?? extensionOf(filename) ?? 'bin';
}

export async function convertToPlainText(
  bytes: Buffer,
  mimeType: string,
  filename: string,
  opts: SofficeOptions,
): Promise<SofficeResult> {
  const spawnImpl = opts.spawnFn ?? spawn;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'cdfir-soffice-'));
    const ext = inputExtension(mimeType, filename);
    // Fixed input name: the original filename may contain characters that are
    // awkward on a command line, and soffice derives the output name from it.
    const inputPath = join(dir, `input.${ext}`);
    await writeFile(inputPath, bytes);

    // Stage 1: render to PDF. See the module comment for why not txt:Text.
    const converted = await runProcess(
      spawnImpl,
      'soffice',
      [
        '--headless',
        '--invisible',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        // A private profile per invocation. LibreOffice serialises on a shared
        // user profile, so concurrent conversions would block or fail against
        // each other — and the worker runs many jobs at once.
        `-env:UserInstallation=file://${join(dir, 'profile')}`,
        '--convert-to',
        'pdf',
        '--outdir',
        dir,
        inputPath,
      ],
      opts.timeoutMs,
      'LibreOffice',
    );
    if (!converted.ok) return converted;

    const pdf = (await readdir(dir)).find((f) => f.endsWith('.pdf'));
    if (pdf === undefined) {
      // soffice exits 0 even when it silently declines the format, so the
      // absence of output is the only reliable signal that it failed.
      return { ok: false, reason: 'LibreOffice produced no PDF' };
    }

    // Stage 2: pull the text out of the rendered PDF.
    const textPath = join(dir, 'out.txt');
    const extracted = await runProcess(
      spawnImpl,
      'pdftotext',
      ['-q', '-enc', 'UTF-8', join(dir, pdf), textPath],
      opts.timeoutMs,
      'pdftotext',
    );
    if (!extracted.ok) return extracted;

    let raw: Buffer;
    try {
      raw = await readFile(textPath);
    } catch {
      return { ok: false, reason: 'pdftotext produced no output file' };
    }
    const text = raw.subarray(0, opts.maxTextBytes).toString('utf8');
    if (text.trim().length === 0) {
      // An empty conversion is not a success: recording it as extracted text
      // would make the item look searched when nothing was indexed. A
      // graphics-only document legitimately lands here.
      return { ok: false, reason: 'conversion produced no extractable text' };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Run a converter, bounding it in time and never throwing. */
function runProcess(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<SofficeResult> {
  return new Promise<SofficeResult>((resolve) => {
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      // Bounded: a runaway converter must not grow this without limit.
      if (stderr.length < 4096) stderr += c.toString('utf8');
    });

    let settled = false;
    const finish = (r: SofficeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: soffice ignores polite signals when wedged on
      // malformed input, and a stuck converter would hold the job forever.
      child.kill('SIGKILL');
      finish({ ok: false, reason: `${label} timed out after ${String(timeoutMs)}ms` });
    }, timeoutMs);

    child.on('error', (err: Error) => {
      finish({ ok: false, reason: `${label} could not be started: ${err.message}` });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) finish({ ok: true, text: '' });
      else {
        finish({
          ok: false,
          reason: `${label} exited with code ${String(code)}${stderr !== '' ? `: ${stderr.slice(0, 300)}` : ''}`,
        });
      }
    });
  });
}
