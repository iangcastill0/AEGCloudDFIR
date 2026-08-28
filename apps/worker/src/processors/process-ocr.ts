import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvent, withTenantContext, type Prisma } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { readAllCapped } from '../streams.js';
import { ocrDecision } from './ocr-policy.js';
import type { EvidenceStagePayload } from './payloads.js';

const MAX_INPUT_BYTES = 200 * 1024 * 1024;

export interface OcrPageResult {
  text: string;
  confidence: number;
}

/** Injectable OCR engine so tests never spawn processes. */
export interface OcrRunner {
  /** null when tesseract is unavailable on this host. */
  tesseractVersion(): Promise<string | null>;
  /** Whether PDF page rasterization (pdftoppm) is available. */
  pdfRasterAvailable(): Promise<boolean>;
  ocrImage(image: Buffer, langs: string): Promise<OcrPageResult>;
  pdfToImages(pdf: Buffer, maxPages: number): Promise<Buffer[]>;
  /**
   * Convert an Office document to PDF so it can be rasterised and read.
   *
   * Returns null when LibreOffice is unavailable or produced nothing, which is
   * reported as an exception rather than treated as "no text found" — a scan
   * that silently yields nothing is indistinguishable from an empty document.
   */
  documentToPdf(document: Buffer, extension: string): Promise<Buffer | null>;
}

function run(
  command: string,
  args: string[],
  stdin?: Buffer,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Mean word confidence + concatenated text from tesseract TSV output. */
export function parseTesseractTsv(tsv: string): OcrPageResult {
  const words: string[] = [];
  let confSum = 0;
  let confCount = 0;
  for (const line of tsv.split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const text = cols[11]?.trim() ?? '';
    if (text === '') continue;
    words.push(text);
    if (Number.isFinite(conf) && conf >= 0) {
      confSum += conf;
      confCount += 1;
    }
  }
  return { text: words.join(' '), confidence: confCount > 0 ? confSum / confCount : 0 };
}

class CliOcrRunner implements OcrRunner {
  private tesseract: Promise<string | null> | undefined;
  private pdftoppm: Promise<boolean> | undefined;

  tesseractVersion(): Promise<string | null> {
    this.tesseract ??= run('tesseract', ['--version'])
      .then((r) => {
        if (r.code !== 0) return null;
        const first = r.stdout.toString('utf8').split('\n')[0] ?? '';
        return first.replace(/^tesseract\s*/i, '').trim() || 'unknown';
      })
      .catch(() => null);
    return this.tesseract;
  }

  pdfRasterAvailable(): Promise<boolean> {
    this.pdftoppm ??= run('pdftoppm', ['-v'])
      .then((r) => r.code === 0 || r.stderr.includes('pdftoppm'))
      .catch(() => false);
    return this.pdftoppm;
  }

  async ocrImage(image: Buffer, langs: string): Promise<OcrPageResult> {
    const result = await run('tesseract', ['stdin', 'stdout', '-l', langs, 'tsv'], image);
    if (result.code !== 0) {
      throw new Error(`tesseract exited with code ${result.code}`);
    }
    return parseTesseractTsv(result.stdout.toString('utf8'));
  }

  async pdfToImages(pdf: Buffer, maxPages: number): Promise<Buffer[]> {
    const dir = await mkdtemp(join(tmpdir(), 'cdfir-ocr-'));
    try {
      const pdfPath = join(dir, 'input.pdf');
      await writeFile(pdfPath, pdf);
      const result = await run('pdftoppm', [
        '-png',
        '-r',
        '150',
        '-l',
        String(maxPages),
        pdfPath,
        join(dir, 'page'),
      ]);
      if (result.code !== 0) {
        throw new Error(`pdftoppm exited with code ${result.code}`);
      }
      const files = (await readdir(dir)).filter((f) => f.startsWith('page') && f.endsWith('.png'));
      files.sort();
      const images: Buffer[] = [];
      for (const file of files.slice(0, maxPages)) {
        images.push(await readFile(join(dir, file)));
      }
      return images;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * LibreOffice headless, document in and PDF out, in a private profile
   * directory.
   *
   * The profile matters: concurrent soffice runs sharing the default profile
   * fight over a lock and one of them silently produces no file. The extension
   * matters too — LibreOffice picks its import filter from the file name, and a
   * .docx handed over as `input` is not recognised at all.
   */
  async documentToPdf(document: Buffer, extension: string): Promise<Buffer | null> {
    const dir = await mkdtemp(join(tmpdir(), 'cdfir-soffice-'));
    try {
      const safeExt = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : 'doc';
      const inputPath = join(dir, `input.${safeExt}`);
      await writeFile(inputPath, document);
      const result = await run('soffice', [
        '--headless',
        '--norestore',
        `-env:UserInstallation=file://${join(dir, 'profile')}`,
        '--convert-to',
        'pdf',
        '--outdir',
        dir,
        inputPath,
      ]);
      if (result.code !== 0) return null;
      // Exit code 0 is not proof of output: LibreOffice reports success and
      // writes nothing when it cannot read the file. Only the PDF counts.
      const produced = (await readdir(dir)).find((f) => f.endsWith('.pdf'));
      if (produced === undefined) return null;
      return await readFile(join(dir, produced));
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const defaultRunner = new CliOcrRunner();

/** The real runner, for tests that must exercise the actual binaries. */
export function createOcrRunner(): OcrRunner {
  return new CliOcrRunner();
}

export interface OcrDeps {
  runner?: OcrRunner;
}

/**
 * process.ocr: OCR images and PDFs via the tesseract CLI. Engine
 * unavailability is an HONEST exception (kind 'other'), never a fabricated
 * result or a pipeline failure — indexing still proceeds with whatever text
 * exists.
 */
export async function processOcr(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  deps: OcrDeps = {},
): Promise<void> {
  const { tenantId, evidenceItemId } = payload;
  const version = payload.version;
  const runner = deps.runner ?? defaultRunner;

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: {
        blob: true,
        ocrPages: { select: { id: true }, take: 1 },
        extractedTexts: { select: { charCount: true }, orderBy: { charCount: 'desc' }, take: 1 },
      },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'ocr: evidence item not found; dropping');
    return;
  }
  if (item.ocrPages.length > 0) return; // already OCRed (idempotent)
  if (item.blob === null) return;

  const decision = ocrDecision({
    mimeType: item.mimeType,
    // Extraction has already run by the time OCR is queued; this re-reads its
    // result so a document with real text is never rasterised needlessly.
    extractedChars: item.extractedTexts?.[0]?.charCount ?? 0,
  });
  if (!decision.run) return;
  // A converted document becomes a PDF, so it takes the PDF path from there.
  const isPdf = decision.reason === 'pdf' || decision.convertFirst;

  const engineVersion = await runner.tesseractVersion();
  const rasterOk = isPdf ? await runner.pdfRasterAvailable() : true;
  if (engineVersion === null || !rasterOk) {
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      if (item.collectionId !== null) {
        await recordException(tx, {
          tenantId,
          collectionId: item.collectionId,
          custodianId: item.custodianId ?? undefined,
          providerItemId: item.providerItemId,
          kind: 'other',
          message:
            engineVersion === null
              ? 'ocr engine unavailable on this host'
              : 'pdf rasterizer unavailable on this host; pdf ocr skipped',
        });
      }
      await enqueueIndex(tx, tenantId, evidenceItemId, version);
    });
    return;
  }

  const stream = await ctx.store.getStream(
    item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
    item.blob.objectKey,
  );
  const input = await readAllCapped(stream, MAX_INPUT_BYTES);

  let pages: OcrPageResult[];
  try {
    let toRasterize = input;
    if (decision.convertFirst) {
      const converted = await runner.documentToPdf(input, item.extension);
      if (converted === null) {
        throw new Error('document could not be converted to pdf for ocr');
      }
      toRasterize = converted;
    }
    if (isPdf) {
      const images = await runner.pdfToImages(toRasterize, ctx.config.CDFIR_MAX_OCR_PAGES);
      pages = [];
      for (const image of images) {
        pages.push(await runner.ocrImage(image, ctx.config.CDFIR_OCR_LANGS));
      }
    } else {
      pages = [await runner.ocrImage(input, ctx.config.CDFIR_OCR_LANGS)];
    }
  } catch (err) {
    // Engine failure on this item: honest exception, no retry storm.
    const message = sanitizeError(err);
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      if (item.collectionId !== null) {
        await recordException(tx, {
          tenantId,
          collectionId: item.collectionId,
          custodianId: item.custodianId ?? undefined,
          providerItemId: item.providerItemId,
          kind: 'other',
          message: `ocr failed: ${message}`,
        });
      }
      await enqueueIndex(tx, tenantId, evidenceItemId, version);
    });
    return;
  }

  const fullText = pages
    .map((p) => p.text)
    .join('\n\n')
    .trim();
  const put = await ctx.store.putDerivative(
    tenantId,
    evidenceItemId,
    'ocr',
    version,
    'ocr.txt',
    Buffer.from(fullText, 'utf8'),
    'text/plain; charset=utf-8',
  );

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.ocrPage.createMany({
      data: pages.map((page, index) => ({
        tenantId,
        evidenceItemId,
        pageNumber: index + 1,
        text: page.text,
        confidence: page.confidence,
        engineName: 'tesseract',
        engineVersion: engineVersion,
      })),
      skipDuplicates: true,
    });
    await tx.extractedText.upsert({
      where: { evidenceItemId_kind_version: { evidenceItemId, kind: 'ocr_text', version } },
      create: {
        tenantId,
        evidenceItemId,
        kind: 'ocr_text',
        objectKey: put.objectKey,
        sha256: put.sha256,
        charCount: fullText.length,
        extractorName: 'tesseract',
        extractorVersion: engineVersion,
        version,
      },
      update: { objectKey: put.objectKey, sha256: put.sha256, charCount: fullText.length },
    });
    await tx.evidenceItem.update({
      where: { id: evidenceItemId },
      data: { processingStatus: 'ocr_complete' },
    });
    if (item.collectionId !== null && item.custodianId !== null) {
      await incrementProgress(tx, item.collectionId, item.custodianId, 'drive', {
        ocrExtracted: 1,
      });
    }
    await appendAuditEvent(tx, {
      tenantId,
      action: 'evidence.ocr_completed',
      targetType: 'evidence_item',
      targetId: evidenceItemId,
      actorDisplay: 'worker',
      summary: { pages: pages.length, engineVersion },
    });
    await enqueueIndex(tx, tenantId, evidenceItemId, version);
  });
}

async function enqueueIndex(
  tx: Prisma.TransactionClient,
  tenantId: string,
  evidenceItemId: string,
  version: number,
): Promise<void> {
  await tx.outboxEvent.createMany({
    data: [
      {
        tenantId,
        topic: QUEUES.searchIndex,
        dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'ocr'),
        payload: { tenantId, evidenceItemId, version },
      },
    ],
    skipDuplicates: true,
  });
}
