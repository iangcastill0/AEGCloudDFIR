/**
 * OCR via the Tesseract CLI plus PDF rasterization via pdftoppm.
 *
 * The process runner is injectable so tests never spawn real binaries and
 * the worker can wrap execution with its own resource limits. Output is
 * parsed from Tesseract's TSV format, giving per-word confidence and
 * bounding boxes; page-level results carry a mean confidence.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcrError } from './errors.js';

export interface RunnerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable process runner (cmd, args, optional stdin bytes). */
export type ProcessRunner = (cmd: string, args: string[], stdin?: Buffer) => Promise<RunnerResult>;

export interface OcrWord {
  text: string;
  /** Tesseract confidence 0..100. */
  conf: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  /** Recognized text with line structure preserved. */
  text: string;
  /** Mean confidence over recognized words (0 when no words). */
  meanConfidence: number;
  words: OcrWord[];
}

export interface TesseractOcrOptions {
  /** Language spec passed to -l, e.g. 'eng' or 'eng+deu'. */
  langs: string;
  runner?: ProcessRunner;
  /** Cap on PDF pages rasterized/OCRed per document. */
  maxPages: number;
}

export interface RasterizeOptions {
  runner?: ProcessRunner;
  dpi: number;
  maxPages: number;
}

export interface RasterizeResult {
  /** PNG bytes per page, in order. */
  pages: Buffer[];
  /** True when the document had more pages than maxPages. */
  truncated: boolean;
}

/** Default runner: spawn the real binary with stdin piped. */
export const spawnRunner: ProcessRunner = (cmd, args, stdin) =>
  new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1,
      });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });

interface TsvRow {
  level: number;
  page: number;
  block: number;
  par: number;
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

function parseRow(fields: string[]): TsvRow | null {
  if (fields.length < 12) return null;
  const nums = fields.slice(0, 11).map((f) => Number.parseFloat(f));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    level: nums[0] as number,
    page: nums[1] as number,
    block: nums[2] as number,
    par: nums[3] as number,
    line: nums[4] as number,
    word: nums[5] as number,
    left: nums[6] as number,
    top: nums[7] as number,
    width: nums[8] as number,
    height: nums[9] as number,
    conf: nums[10] as number,
    text: fields.slice(11).join('\t'),
  };
}

/**
 * Parse Tesseract TSV output. Structural rows (page/block/para/line, conf -1)
 * shape the text but are excluded from words and mean confidence.
 */
export function parseTsv(tsv: string): OcrResult {
  const lines = tsv.split(/\r?\n/);
  const words: OcrWord[] = [];
  const textLines: string[] = [];
  let currentKey = '';
  let currentLine: string[] = [];

  const flush = (): void => {
    if (currentLine.length > 0) textLines.push(currentLine.join(' '));
    currentLine = [];
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    // Skip the header row.
    if (fields[0] === 'level') continue;
    const row = parseRow(fields);
    if (row === null) continue;
    // Word rows are level 5; conf -1 rows are structural.
    if (row.level !== 5 || row.conf < 0) continue;
    const text = row.text.trim();
    if (text === '') continue;
    const key = `${row.page}:${row.block}:${row.par}:${row.line}`;
    if (key !== currentKey) {
      flush();
      currentKey = key;
    }
    currentLine.push(text);
    words.push({ text, conf: row.conf, x: row.left, y: row.top, w: row.width, h: row.height });
  }
  flush();

  const meanConfidence =
    words.length === 0
      ? 0
      : Math.round((words.reduce((sum, w) => sum + w.conf, 0) / words.length) * 100) / 100;

  return { text: textLines.join('\n'), meanConfidence, words };
}

export class TesseractOcr {
  private readonly langs: string;
  private readonly runner: ProcessRunner;
  readonly maxPages: number;

  constructor(options: TesseractOcrOptions) {
    this.langs = options.langs;
    this.runner = options.runner ?? spawnRunner;
    this.maxPages = options.maxPages;
  }

  /** OCR a single raster image (PNG/JPEG/TIFF bytes). */
  async ocrImage(imageBytes: Buffer): Promise<OcrResult> {
    const args = ['stdin', 'stdout', '--psm', '3', '-l', this.langs, 'tsv'];
    const result = await this.runner('tesseract', args, imageBytes);
    if (result.code !== 0) {
      throw new OcrError(`tesseract exited with code ${result.code}`, {
        stderr: result.stderr.slice(0, 2000),
      });
    }
    return parseTsv(result.stdout);
  }

  /** Tesseract engine version ('5.3.4') parsed from `tesseract --version`. */
  async version(): Promise<string> {
    const result = await this.runner('tesseract', ['--version']);
    if (result.code !== 0) {
      throw new OcrError(`tesseract --version exited with code ${result.code}`, {
        stderr: result.stderr.slice(0, 2000),
      });
    }
    // First line: 'tesseract 5.3.4' (some builds print to stderr).
    const source = result.stdout.trim() !== '' ? result.stdout : result.stderr;
    const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
    const match = /^tesseract\s+v?(\S+)/i.exec(firstLine.trim());
    if (match?.[1] === undefined) {
      throw new OcrError(`cannot parse tesseract version from: ${firstLine}`);
    }
    return match[1];
  }
}

/**
 * Rasterize a PDF into per-page PNG buffers with pdftoppm, using temp files
 * under os.tmpdir(). Requests one page beyond maxPages so truncation can be
 * detected without a separate pdfinfo call.
 */
export async function rasterizePdf(
  pdfBytes: Buffer,
  options: RasterizeOptions,
): Promise<RasterizeResult> {
  const runner = options.runner ?? spawnRunner;
  const dir = await mkdtemp(join(tmpdir(), 'cdfir-raster-'));
  try {
    const pdfPath = join(dir, 'input.pdf');
    const prefix = join(dir, 'page');
    await writeFile(pdfPath, pdfBytes);

    const probePages = options.maxPages + 1;
    const args = [
      '-png',
      '-r',
      String(options.dpi),
      '-f',
      '1',
      '-l',
      String(probePages),
      pdfPath,
      prefix,
    ];
    const result = await runner('pdftoppm', args);
    if (result.code !== 0) {
      throw new OcrError(`pdftoppm exited with code ${result.code}`, {
        stderr: result.stderr.slice(0, 2000),
      });
    }

    const pages: Buffer[] = [];
    let truncated = false;
    for (let page = 1; page <= probePages; page += 1) {
      const buffer = await readPageFile(prefix, page, probePages);
      if (buffer === null) break;
      if (page > options.maxPages) {
        truncated = true;
        break;
      }
      pages.push(buffer);
    }
    return { pages, truncated };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * pdftoppm zero-pads page numbers based on total page count; try the padded
 * spellings a small document can produce.
 */
async function readPageFile(
  prefix: string,
  page: number,
  probePages: number,
): Promise<Buffer | null> {
  const width = String(probePages).length;
  const candidates = new Set<string>([
    `${prefix}-${page}.png`,
    `${prefix}-${String(page).padStart(width, '0')}.png`,
    `${prefix}-${String(page).padStart(2, '0')}.png`,
    `${prefix}-${String(page).padStart(3, '0')}.png`,
  ]);
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch {
      // try next padding
    }
  }
  return null;
}
