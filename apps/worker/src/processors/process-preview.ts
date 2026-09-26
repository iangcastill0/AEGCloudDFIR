import { withTenantContext } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { readAllCapped } from '../streams.js';
import { isObjectNotFoundError, recordMissingObject } from './missing-object.js';
import { createOcrRunner, type OcrRunner } from './process-ocr.js';
import type { EvidenceStagePayload } from './payloads.js';
import { previewPlan } from './preview-plan.js';

/**
 * process.preview: make every collected file look at something.
 *
 * This queue existed and did nothing — its handler was a deliberate no-op so
 * enqueued jobs would drain rather than rot. Previews were written in exactly
 * one place, the email parser, so every attachment in a real 43,379-item
 * matter reported "No safe preview is available": 1,379 files, including 759
 * PNGs and 184 PDFs whose bytes had been collected and verified all along.
 *
 * Everything is done with tools already in the worker image (LibreOffice,
 * poppler, ghostscript). No new dependency.
 *
 * Two rules that shape the whole thing:
 *
 * - Previews are always DERIVATIVES, never the evidence object. The preview
 *   endpoint presigns whatever key it is given, and pointing it at the
 *   original would hand out evidence bytes without the infected-item gate the
 *   native download enforces.
 * - A refusal is a result. When a file cannot be rendered, the reason is
 *   recorded and shown. "No safe preview is available" told a reviewer nothing
 *   about whether the file was broken, unsupported, or simply not collected.
 */

/** Enough for the documents in a mailbox; bigger files fall back to a note. */
const MAX_INPUT_BYTES = 200 * 1024 * 1024;

/** Pages rasterised per document. Beyond this the reviewer opens the native. */
const MAX_PREVIEW_PAGES = 20;

/** Text previews are for reading, not for holding a whole log file. */
const MAX_TEXT_BYTES = 512 * 1024;

const GENERATOR = 'cdfir-preview';
const GENERATOR_VERSION = '1';

export interface PreviewDeps {
  runner?: OcrRunner;
}

const defaultRunner = createOcrRunner();

export async function processPreview(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  deps: PreviewDeps = {},
): Promise<void> {
  const { tenantId, evidenceItemId, version } = payload;
  const runner = deps.runner ?? defaultRunner;

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: { blob: true, previews: { select: { id: true }, take: 1 } },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'preview: evidence item not found; dropping');
    return;
  }
  // Idempotent: the email parser already wrote one, or a retry got here first.
  if (item.previews.length > 0) return;
  if (item.blob === null) return;
  // An infected file is never rendered. The native download has its own
  // deliberate gate for that; a preview must not quietly route around it.
  // storageClass is not enough: a shared blob is marked infected and left in
  // the evidence bucket, and image previews copy those bytes verbatim.
  if (item.blob.storageClass === 'quarantine' || item.malwareStatus === 'infected') {
    await note(ctx, tenantId, item, 'This file was quarantined by the malware scan.');
    return;
  }

  const plan = previewPlan(item.mimeType, item.name);
  if (plan.action === 'none') {
    await note(ctx, tenantId, item, plan.reason);
    return;
  }

  let input: Buffer;
  try {
    const stream = await ctx.store.getStream('evidence', item.blob.objectKey);
    input = await readAllCapped(stream, MAX_INPUT_BYTES);
  } catch (err) {
    // "The stored file could not be read" is true of a slow network and of
    // evidence that no longer exists, and this stage wrote both as kind
    // 'other'. A preview is a convenience and a missing object is not, so this
    // one case leaves the convenience rule behind and marks the item.
    if (isObjectNotFoundError(err)) {
      await recordMissingObject(ctx, {
        tenantId,
        item,
        version,
        stage: 'preview',
        bucket: 'evidence',
        objectKey: item.blob.objectKey,
      });
      return;
    }
    await note(ctx, tenantId, item, `The stored file could not be read: ${sanitizeError(err)}`);
    return;
  }

  try {
    if (plan.action === 'image') {
      // Copied verbatim. Re-encoding evidence would show the reviewer pixels
      // that are not the ones collected, and the image has no library to
      // re-encode with anyway.
      const put = await ctx.store.putDerivative(
        tenantId,
        item.id,
        'preview',
        version,
        'preview.bin',
        input,
        item.mimeType,
      );
      await writePreview(ctx, tenantId, item.id, version, {
        kind: 'thumbnail',
        objectKey: put.objectKey,
        mimeType: item.mimeType,
        pageCount: 1,
      });
      return;
    }

    if (plan.action === 'text') {
      const text = input.subarray(0, MAX_TEXT_BYTES).toString('utf8');
      const put = await ctx.store.putDerivative(
        tenantId,
        item.id,
        'preview',
        version,
        'preview.txt',
        Buffer.from(text, 'utf8'),
        'text/plain; charset=utf-8',
      );
      await writePreview(ctx, tenantId, item.id, version, {
        kind: 'text',
        objectKey: put.objectKey,
        mimeType: 'text/plain',
        pageCount: 1,
      });
      return;
    }

    if (!(await runner.pdfRasterAvailable())) {
      await note(ctx, tenantId, item, 'The page renderer is unavailable on this host.');
      return;
    }

    let pdf = input;
    if (plan.action === 'convert-then-rasterize') {
      const converted = await runner.documentToPdf(input, plan.extension ?? '');
      if (converted === null) {
        // Honest, not silent: LibreOffice reports success on some documents
        // while writing no file at all, and treating that as "empty" is how a
        // missing preview looks identical to a blank page.
        await note(
          ctx,
          tenantId,
          item,
          'This document could not be converted for preview. The native file was collected and can be downloaded.',
        );
        return;
      }
      pdf = converted;
    }

    const images = await runner.pdfToImages(pdf, MAX_PREVIEW_PAGES);
    if (images.length === 0) {
      await note(ctx, tenantId, item, 'No pages could be rendered from this document.');
      return;
    }

    // Page N lands at <...>/preview-pageNNN.png. The Preview row points at the
    // first and records the count, so the API can address the rest without a
    // second table.
    let firstKey = '';
    for (const [index, image] of images.entries()) {
      const put = await ctx.store.putDerivative(
        tenantId,
        item.id,
        'preview',
        version,
        `preview-page${String(index + 1).padStart(3, '0')}.png`,
        image,
        'image/png',
      );
      if (index === 0) firstKey = put.objectKey;
    }
    await writePreview(ctx, tenantId, item.id, version, {
      kind: 'page_images',
      objectKey: firstKey,
      mimeType: 'image/png',
      pageCount: images.length,
    });
  } catch (err) {
    // A preview is a convenience; failing to make one must never fail the
    // pipeline or lose the evidence behind it.
    await note(ctx, tenantId, item, `Preview generation failed: ${sanitizeError(err)}`);
  }
}

async function writePreview(
  ctx: WorkerContext,
  tenantId: string,
  evidenceItemId: string,
  version: number,
  row: {
    kind: 'thumbnail' | 'text' | 'page_images';
    objectKey: string;
    mimeType: string;
    pageCount: number;
  },
): Promise<void> {
  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.preview.upsert({
      where: { evidenceItemId_kind_version: { evidenceItemId, kind: row.kind, version } },
      create: {
        tenantId,
        evidenceItemId,
        kind: row.kind,
        objectKey: row.objectKey,
        mimeType: row.mimeType,
        pageCount: row.pageCount,
        generatorName: GENERATOR,
        generatorVersion: GENERATOR_VERSION,
        version,
      },
      update: { objectKey: row.objectKey, pageCount: row.pageCount },
    }),
  );
}

/**
 * Record why there is no preview, where the operator will see it.
 *
 * Kind 'other' rather than a failure: an unpreviewable file is a normal,
 * expected outcome for a ZIP or a video, not a fault. What is NOT acceptable
 * is saying nothing, which is what the product did before.
 */
async function note(
  ctx: WorkerContext,
  tenantId: string,
  item: {
    id: string;
    collectionId: string | null;
    custodianId: string | null;
    providerItemId: string;
  },
  reason: string,
): Promise<void> {
  if (item.collectionId === null) return;
  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    recordException(tx, {
      tenantId,
      collectionId: item.collectionId as string,
      custodianId: item.custodianId ?? undefined,
      providerItemId: item.providerItemId,
      kind: 'other',
      message: `no preview: ${reason}`,
    }),
  );
}
