import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OcrError } from './errors.js';
import {
  TesseractOcr,
  parseTsv,
  rasterizePdf,
  type ProcessRunner,
  type RunnerResult,
} from './ocr.js';

const HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

// Realistic tesseract TSV: structural rows carry conf -1 and must not count.
const SAMPLE_TSV = [
  HEADER,
  '1\t1\t0\t0\t0\t0\t0\t0\t1000\t1400\t-1\t',
  '2\t1\t1\t0\t0\t0\t60\t72\t880\t120\t-1\t',
  '3\t1\t1\t1\t0\t0\t60\t72\t880\t120\t-1\t',
  '4\t1\t1\t1\t1\t0\t60\t72\t880\t40\t-1\t',
  '5\t1\t1\t1\t1\t1\t60\t72\t180\t40\t96.5\tInvoice',
  '5\t1\t1\t1\t1\t2\t260\t72\t120\t40\t91.2\tNumber',
  '4\t1\t1\t1\t2\t0\t60\t130\t880\t40\t-1\t',
  '5\t1\t1\t1\t2\t1\t60\t130\t150\t40\t88.0\tTotal:',
  '5\t1\t1\t1\t2\t2\t230\t130\t130\t40\t84.3\t$1,250.00',
].join('\n');

describe('parseTsv', () => {
  it('extracts words with boxes and excludes conf -1 structural rows', () => {
    const result = parseTsv(SAMPLE_TSV);
    expect(result.words).toHaveLength(4);
    expect(result.words[0]).toEqual({
      text: 'Invoice',
      conf: 96.5,
      x: 60,
      y: 72,
      w: 180,
      h: 40,
    });
    // (96.5 + 91.2 + 88.0 + 84.3) / 4 = 90.0
    expect(result.meanConfidence).toBe(90);
  });

  it('groups words into lines', () => {
    const result = parseTsv(SAMPLE_TSV);
    expect(result.text).toBe('Invoice Number\nTotal: $1,250.00');
  });

  it('handles empty input', () => {
    const result = parseTsv('');
    expect(result).toEqual({ text: '', meanConfidence: 0, words: [] });
  });

  it('ignores malformed rows', () => {
    const result = parseTsv(
      `${HEADER}\nnot\ta\tvalid\trow\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t80\tok`,
    );
    expect(result.words.map((w) => w.text)).toEqual(['ok']);
  });
});

describe('TesseractOcr.ocrImage', () => {
  it('invokes tesseract with stdin/stdout, psm, langs, and tsv output', async () => {
    const calls: { cmd: string; args: string[]; stdin?: Buffer }[] = [];
    const runner: ProcessRunner = (cmd, args, stdin) => {
      const call: { cmd: string; args: string[]; stdin?: Buffer } = { cmd, args };
      if (stdin !== undefined) call.stdin = stdin;
      calls.push(call);
      return Promise.resolve({ stdout: SAMPLE_TSV, stderr: '', code: 0 });
    };
    const ocr = new TesseractOcr({ langs: 'eng+deu', runner, maxPages: 20 });

    const image = Buffer.from('fake-png-bytes');
    const result = await ocr.ocrImage(image);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('tesseract');
    expect(calls[0]?.args).toEqual(['stdin', 'stdout', '--psm', '3', '-l', 'eng+deu', 'tsv']);
    expect(calls[0]?.stdin).toBe(image);
    expect(result.text).toContain('Invoice Number');
    expect(result.meanConfidence).toBe(90);
  });

  it('throws OcrError on non-zero exit', async () => {
    const runner: ProcessRunner = () =>
      Promise.resolve({ stdout: '', stderr: 'Error: bad image', code: 1 });
    const ocr = new TesseractOcr({ langs: 'eng', runner, maxPages: 5 });
    await expect(ocr.ocrImage(Buffer.from('x'))).rejects.toBeInstanceOf(OcrError);
  });
});

describe('TesseractOcr.version', () => {
  it('parses the version from the first line', async () => {
    const runner: ProcessRunner = () =>
      Promise.resolve({
        stdout: 'tesseract 5.3.4\n leptonica-1.84.1\n  libgif 5.2.1',
        stderr: '',
        code: 0,
      });
    const ocr = new TesseractOcr({ langs: 'eng', runner, maxPages: 5 });
    await expect(ocr.version()).resolves.toBe('5.3.4');
  });

  it('accepts builds that print the version to stderr', async () => {
    const runner: ProcessRunner = () =>
      Promise.resolve({ stdout: '', stderr: 'tesseract v4.1.1\n', code: 0 });
    const ocr = new TesseractOcr({ langs: 'eng', runner, maxPages: 5 });
    await expect(ocr.version()).resolves.toBe('4.1.1');
  });
});

/** Fake pdftoppm: writes `pageCount` PNG files using the prefix in args. */
function fakePdftoppm(pageCount: number): ProcessRunner {
  return async (cmd, args): Promise<RunnerResult> => {
    expect(cmd).toBe('pdftoppm');
    const prefix = args[args.length - 1] as string;
    const lastPage = Number.parseInt(args[args.indexOf('-l') + 1] as string, 10);
    for (let page = 1; page <= Math.min(pageCount, lastPage); page += 1) {
      await writeFile(`${prefix}-${page}.png`, Buffer.from(`png-page-${page}`));
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

describe('rasterizePdf', () => {
  it('returns one buffer per page in order', async () => {
    const result = await rasterizePdf(Buffer.from('%PDF-1.4'), {
      runner: fakePdftoppm(3),
      dpi: 150,
      maxPages: 10,
    });
    expect(result.truncated).toBe(false);
    expect(result.pages.map((p) => p.toString('utf8'))).toEqual([
      'png-page-1',
      'png-page-2',
      'png-page-3',
    ]);
  });

  it('caps pages at maxPages and sets the truncated flag', async () => {
    const result = await rasterizePdf(Buffer.from('%PDF-1.4'), {
      runner: fakePdftoppm(9),
      dpi: 72,
      maxPages: 4,
    });
    expect(result.truncated).toBe(true);
    expect(result.pages).toHaveLength(4);
    expect(result.pages[3]?.toString('utf8')).toBe('png-page-4');
  });

  it('passes dpi and page range to pdftoppm', async () => {
    let seenArgs: string[] = [];
    const runner: ProcessRunner = async (cmd, args) => {
      seenArgs = args;
      const prefix = args[args.length - 1] as string;
      await writeFile(`${prefix}-1.png`, Buffer.from('p1'));
      return { stdout: '', stderr: '', code: 0 };
    };
    await rasterizePdf(Buffer.from('%PDF-1.4'), { runner, dpi: 300, maxPages: 2 });
    expect(seenArgs).toContain('-png');
    expect(seenArgs[seenArgs.indexOf('-r') + 1]).toBe('300');
    expect(seenArgs[seenArgs.indexOf('-f') + 1]).toBe('1');
    expect(seenArgs[seenArgs.indexOf('-l') + 1]).toBe('3'); // maxPages + 1 truncation probe
  });

  it('throws OcrError when pdftoppm fails', async () => {
    const runner: ProcessRunner = () =>
      Promise.resolve({ stdout: '', stderr: 'Syntax Error: broken pdf', code: 1 });
    await expect(
      rasterizePdf(Buffer.from('junk'), { runner, dpi: 150, maxPages: 5 }),
    ).rejects.toBeInstanceOf(OcrError);
  });
});
