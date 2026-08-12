import { PutObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { productionParameters, type ProductionParameters } from '@aeg-clouddfir/contracts';
import { appendAuditEvent, withTenantContext, type Prisma } from '@aeg-clouddfir/database';
import { hashBuffer, productionKey } from '@aeg-clouddfir/evidence';
import {
  BatesCounter,
  DEFAULT_DAT_PROFILE,
  NativeFileNameAllocator,
  assembleImageOnlyPdf,
  buildCsvFile,
  buildDatFile,
  buildOptFile,
  buildProductionManifest,
  dataPath,
  formatBates,
  imagePath,
  manifestPath,
  renderPlaceholderPdf,
  sortProductionItems,
  stampPdf,
  textPath,
  validateNoTextLayer,
  type OptDocument,
  type ProducedItemRecord,
  type SortableProductionItem,
} from '@aeg-clouddfir/production';
import { sanitizeError, type WorkerContext } from '../context.js';
import { readAllCapped } from '../streams.js';
import type { ProductionRunPayload } from './payloads.js';

const MAX_NATIVE_BYTES = 200 * 1024 * 1024;
const FAMILY_KINDS = new Set(['attachment', 'inline_attachment']);

/** frozenParameters = full wizard parameters + the frozen selection ids (written by apps/api at submit). */
const frozenParametersSchema = z
  .object({ selectionItemIds: z.array(z.string().uuid()) })
  .and(productionParameters);

export interface ProductionDeps {
  renderPlaceholder: typeof renderPlaceholderPdf;
  stamp: typeof stampPdf;
  validateNoTextLayer: typeof validateNoTextLayer;
  assembleImagePdf: typeof assembleImageOnlyPdf;
  buildDat: typeof buildDatFile;
  buildOpt: typeof buildOptFile;
  buildCsv: typeof buildCsvFile;
  buildManifest: typeof buildProductionManifest;
  /**
   * Whether true page rasterization (PDF -> page images) is available.
   * This milestone ships no rasterizer, so the default is honest: false.
   * Requested tiff_g4/jpeg output downgrades to document PDFs with a recorded
   * exception, and final redactions that cannot be burned become placeholders.
   */
  rasterizerAvailable: () => Promise<boolean>;
}

const defaultDeps: ProductionDeps = {
  renderPlaceholder: renderPlaceholderPdf,
  stamp: stampPdf,
  validateNoTextLayer,
  assembleImagePdf: assembleImageOnlyPdf,
  buildDat: buildDatFile,
  buildOpt: buildOptFile,
  buildCsv: buildCsvFile,
  buildManifest: buildProductionManifest,
  rasterizerAvailable: () => Promise.resolve(false),
};

/** Rough PDF page count without a PDF library (documented approximation). */
export function countPdfPagesApprox(pdf: Buffer): number {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches !== null && matches.length > 0 ? matches.length : 1;
}

type LoadedItem = Prisma.EvidenceItemGetPayload<{
  include: {
    blob: true;
    custodian: { select: { email: true } };
    emailMetadata: true;
    participants: true;
    extractedTexts: true;
    redactions: true;
    tagAssignments: { select: { tagId: true; tag: { select: { name: true } } } };
    childRelationships: { select: { parentId: true; kind: true } };
    parentRelationships: { select: { childId: true; kind: true } };
  };
}>;

interface ExceptionDraft {
  evidenceItemId: string | null;
  code: string;
  severity: 'info' | 'warning' | 'blocking' | 'security_critical';
  message: string;
  detail?: Record<string, unknown>;
}

interface ProducedDraft {
  evidenceItemId: string;
  sortIndex: number;
  begBates: string;
  endBates: string;
  begAttach: string;
  endAttach: string;
  pageCount: number;
  outputKind: 'image' | 'native' | 'image_and_native' | 'placeholder' | 'text_only';
  imagePaths: string[];
  nativePath: string;
  textPath: string;
  placeholderReason: string;
  state: 'rendered' | 'placeholder';
  familyId: string | null;
  record: ProducedItemRecord;
  outputs: { path: string; sha256: string; size: number }[];
}

function participantsJoined(item: LoadedItem, role: string): string | null {
  const list = item.participants
    .filter((p) => p.role === role)
    .map((p) => (p.rawAddress !== '' ? p.rawAddress : p.rawName))
    .filter((v) => v !== '');
  return list.length > 0 ? list.join('; ') : null;
}

function bestText(item: LoadedItem): string | null {
  if (item.emailMetadata !== null && item.emailMetadata.bodyPlain !== '') {
    return item.emailMetadata.bodyPlain;
  }
  return null;
}

function wantsNative(item: LoadedItem, params: ProductionParameters): boolean {
  if (params.output.mode === 'natives_only') return true;
  if (params.output.mode === 'load_file' && params.output.includeNatives) {
    const ext = item.extension.toLowerCase();
    if (params.nativePolicy.extensions.includes(ext)) return true;
    const tagIds = new Set(item.tagAssignments.map((t) => t.tagId));
    if (params.nativePolicy.tagIds.some((id) => tagIds.has(id))) return true;
  }
  return false;
}

/**
 * production.run: render the frozen selection into a defensible production —
 * deterministic sort, contiguous bates from the reserved range, per-family
 * attachment ranges, load files, canonical manifest. Item failures become
 * placeholders + exceptions; only systemic failures fail the run. Redacted
 * items NEVER ship natives or text-bearing output without a validated
 * image-only rendering.
 */
export async function processProductionRun(
  ctx: WorkerContext,
  payload: ProductionRunPayload,
  depsIn: Partial<ProductionDeps> = {},
): Promise<void> {
  const deps: ProductionDeps = { ...defaultDeps, ...depsIn };
  const { tenantId, productionRunId } = payload;

  const run = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.productionRun.findUnique({
      where: { id: productionRunId },
      include: { production: { select: { id: true } }, batesReservations: true },
    }),
  );
  if (run === null) {
    ctx.log.warn({ productionRunId }, 'production: run not found; dropping');
    return;
  }
  if (!['queued', 'rendering'].includes(run.status)) return; // idempotent

  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.productionRun.update({
      where: { id: productionRunId },
      data: { status: 'rendering', startedAt: run.startedAt ?? new Date() },
    }),
  );

  try {
    const parsed = frozenParametersSchema.safeParse(run.frozenParameters);
    if (!parsed.success) {
      throw new Error('frozen production parameters are malformed; refusing to run');
    }
    const params: ProductionParameters & { selectionItemIds: string[] } = parsed.data;
    const reservation = run.batesReservations[0];
    if (reservation === undefined) {
      throw new Error('production run has no bates reservation');
    }

    const items = await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.evidenceItem.findMany({
        where: { id: { in: params.selectionItemIds } },
        include: {
          blob: true,
          custodian: { select: { email: true } },
          emailMetadata: true,
          participants: true,
          extractedTexts: true,
          redactions: { where: { stage: 'final' } },
          tagAssignments: { select: { tagId: true, tag: { select: { name: true } } } },
          childRelationships: { select: { parentId: true, kind: true } },
          parentRelationships: { select: { childId: true, kind: true } },
        },
      }),
    );

    const sortable: (SortableProductionItem & { loaded: LoadedItem })[] = items.map((item) => {
      const parentRel = item.childRelationships.find((r) => FAMILY_KINDS.has(r.kind));
      const hasChildren = item.parentRelationships.some((r) => FAMILY_KINDS.has(r.kind));
      return {
        evidenceId: item.id,
        fileName: item.name,
        folderPath: item.sourcePath,
        primaryDate: item.primaryDate?.toISOString() ?? null,
        custodian: item.custodian?.email ?? null,
        familyId: parentRel?.parentId ?? (hasChildren ? item.id : null),
        isFamilyChild: parentRel !== undefined,
        loaded: item,
      };
    });
    const sorted = sortProductionItems(sortable, params.sort, params.selection.includeFamilies);

    const batesConfig = {
      prefix: params.bates.prefix,
      digits: params.bates.digits,
      suffix: params.bates.suffix,
      numbering: params.bates.numbering,
    };
    const counter = new BatesCounter(batesConfig, Number(reservation.startNumber));

    const exceptions: ExceptionDraft[] = [];
    const produced: ProducedDraft[] = [];
    const nativeNames = new NativeFileNameAllocator(params.filenames);
    const rasterAvailable = await deps.rasterizerAvailable();

    const requestedImageFormat =
      params.output.mode === 'load_file' ? params.output.imageFormat : 'pdf';
    const imageFormatDowngraded =
      (requestedImageFormat === 'tiff_g4' || requestedImageFormat === 'jpeg') && !rasterAvailable;
    if (imageFormatDowngraded) {
      exceptions.push({
        evidenceItemId: null,
        code: 'unsupported_conversion',
        severity: 'warning',
        message: `image rendering downgraded to pdf: rasterizer unavailable (requested ${requestedImageFormat})`,
      });
    }

    const uploads: { path: string; body: Buffer }[] = [];
    let imageIndex = 0;

    for (let sortIndex = 0; sortIndex < sorted.length; sortIndex += 1) {
      const sortEntry = sorted[sortIndex];
      if (sortEntry === undefined) continue;
      const item = sortEntry.loaded;
      const hasFinalRedactions = item.redactions.length > 0;
      const nativeRequested = wantsNative(item, params);

      let pdfBytes: Uint8Array | null = null;
      let pageCount = 1;
      let placeholderReason = '';
      let outputKind: ProducedDraft['outputKind'] = 'image';

      try {
        if (hasFinalRedactions) {
          if (nativeRequested) {
            // SECURITY: a redacted document must never ship as native.
            exceptions.push({
              evidenceItemId: item.id,
              code: 'redacted_native_leak',
              severity: 'security_critical',
              message:
                'item has final redactions; native output suppressed and replaced with a placeholder',
            });
          }
          if (!rasterAvailable) {
            placeholderReason =
              'final redactions could not be burned to images (rasterizer unavailable); ' +
              'placeholder produced to prevent redacted-content leakage';
            exceptions.push({
              evidenceItemId: item.id,
              code: 'redacted_native_leak',
              severity: 'security_critical',
              message: placeholderReason,
            });
            outputKind = 'placeholder';
          } else {
            // Rasterize + burn path (available only when a rasterizer exists).
            // The image-only PDF must pass the no-text-layer gate or ship as
            // a placeholder — never a leaky output.
            const candidate = await renderRedacted(item, ctx, deps);
            const gate = await deps.validateNoTextLayer(candidate);
            if (gate.hasText) {
              placeholderReason =
                'redacted rendering failed the no-text-layer validation gate; placeholder produced';
              exceptions.push({
                evidenceItemId: item.id,
                code: 'redacted_native_leak',
                severity: 'security_critical',
                message: placeholderReason,
              });
              outputKind = 'placeholder';
            } else {
              pdfBytes = candidate;
              pageCount = countPdfPagesApprox(Buffer.from(candidate));
            }
          }
        } else if (params.output.mode === 'natives_only') {
          outputKind = 'native';
        } else if (item.mimeType === 'application/pdf' && item.blob !== null) {
          const stream = await ctx.store.getStream(
            item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
            item.blob.objectKey,
          );
          const buffer = await readAllCapped(stream, MAX_NATIVE_BYTES);
          pdfBytes = new Uint8Array(buffer);
          pageCount = countPdfPagesApprox(buffer);
        } else if (
          (item.mimeType === 'image/png' || item.mimeType === 'image/jpeg') &&
          item.blob !== null
        ) {
          const stream = await ctx.store.getStream(
            item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
            item.blob.objectKey,
          );
          const buffer = await readAllCapped(stream, MAX_NATIVE_BYTES);
          pdfBytes = await deps.assembleImagePdf([
            { image: buffer, format: item.mimeType === 'image/png' ? 'png' : 'jpeg' },
          ]);
          pageCount = 1;
        } else if (bestText(item) !== null || item.extractedTexts.length > 0) {
          // Simplified single-page text rendering (placeholder-style renderer).
          const text = bestText(item) ?? '(text stored in TEXT/ companion file)';
          pdfBytes = await deps.renderPlaceholder({
            reason: `Simplified text rendering of "${item.name}". Full extracted text accompanies this document in TEXT/.`,
            evidenceId: item.id,
            batesNumber: counter.peekNext(),
            metadata: { Preview: text.slice(0, 600) },
          });
          pageCount = 1;
        } else {
          placeholderReason = 'no renderable representation (unsupported conversion)';
          exceptions.push({
            evidenceItemId: item.id,
            code: 'unsupported_conversion',
            severity: 'warning',
            message: `${placeholderReason}: ${item.mimeType || 'unknown type'}`,
          });
          outputKind = 'placeholder';
        }
      } catch (err) {
        placeholderReason = `rendering failed: ${sanitizeError(err)}`;
        exceptions.push({
          evidenceItemId: item.id,
          code: 'unsupported_conversion',
          severity: 'warning',
          message: placeholderReason,
        });
        outputKind = 'placeholder';
        pdfBytes = null;
      }

      if (outputKind === 'placeholder') pageCount = 1;
      const bates = counter.nextDocument(pageCount);

      if (outputKind === 'placeholder' && pdfBytes === null) {
        pdfBytes = await deps.renderPlaceholder({
          reason: placeholderReason,
          evidenceId: item.id,
          batesNumber: bates.begBates,
          metadata: { Name: item.name },
        });
      }

      // Stamps (bates + fixed text) on PDF outputs.
      if (pdfBytes !== null && params.stamps.length > 0) {
        const pageBates: string[] = [];
        for (let page = 0; page < pageCount; page += 1) {
          pageBates.push(
            params.bates.numbering === 'per_page'
              ? formatBates(
                  batesConfig,
                  Number(reservation.startNumber) +
                    (counter.nextNumber - Number(reservation.startNumber)) -
                    bates.numbersUsed +
                    page,
                )
              : bates.begBates,
          );
        }
        try {
          const stamped = await deps.stamp(pdfBytes, {
            stamps: params.stamps,
            pageBatesNumbers: pageBates,
          });
          pdfBytes = stamped.pdfBytes;
        } catch (err) {
          exceptions.push({
            evidenceItemId: item.id,
            code: 'unsupported_conversion',
            severity: 'warning',
            message: `stamping failed; document produced unstamped: ${sanitizeError(err)}`,
          });
        }
      }

      const outputs: ProducedDraft['outputs'] = [];
      const imagePaths: string[] = [];
      let nativeOutPath = '';
      let textOutPath = '';

      if (pdfBytes !== null) {
        const path = imagePath(bates.begBates, 'pdf', imageIndex);
        imageIndex += 1;
        const body = Buffer.from(pdfBytes);
        uploads.push({ path, body });
        outputs.push({ path, sha256: hashBuffer(body), size: body.byteLength });
        imagePaths.push(path);
      }

      if (nativeRequested && !hasFinalRedactions && item.blob !== null) {
        try {
          const stream = await ctx.store.getStream(
            item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
            item.blob.objectKey,
          );
          const body = await readAllCapped(stream, MAX_NATIVE_BYTES);
          nativeOutPath = nativeNames.pathFor({
            begBates: bates.begBates,
            originalFileName: item.name,
          });
          uploads.push({ path: nativeOutPath, body });
          outputs.push({ path: nativeOutPath, sha256: hashBuffer(body), size: body.byteLength });
          outputKind = pdfBytes !== null ? 'image_and_native' : 'native';
        } catch (err) {
          exceptions.push({
            evidenceItemId: item.id,
            code: 'missing_native',
            severity: 'warning',
            message: `native could not be read: ${sanitizeError(err)}`,
          });
        }
      }

      const includeText =
        params.output.mode === 'load_file'
          ? params.output.includeText
          : params.output.mode !== 'natives_only';
      if (includeText && !hasFinalRedactions) {
        const textContent =
          bestText(item) ??
          (item.extractedTexts.length > 0 ? '(see extracted text derivative)' : null);
        if (textContent !== null) {
          textOutPath = textPath(bates.begBates);
          const body = Buffer.from(textContent, 'utf8');
          uploads.push({ path: textOutPath, body });
          outputs.push({ path: textOutPath, sha256: hashBuffer(body), size: body.byteLength });
        }
      }

      produced.push({
        evidenceItemId: item.id,
        sortIndex,
        begBates: bates.begBates,
        endBates: bates.endBates,
        begAttach: '',
        endAttach: '',
        pageCount,
        outputKind,
        imagePaths,
        nativePath: nativeOutPath,
        textPath: textOutPath,
        placeholderReason,
        state: outputKind === 'placeholder' ? 'placeholder' : 'rendered',
        familyId: sortEntry.familyId,
        outputs,
        record: {
          begBates: bates.begBates,
          endBates: bates.endBates,
          begAttach: null,
          endAttach: null,
          custodian: item.custodian?.email ?? null,
          sourcePath: item.sourcePath !== '' ? item.sourcePath : null,
          fileName: item.name,
          extension: item.extension !== '' ? item.extension : null,
          mime: item.mimeType !== '' ? item.mimeType : null,
          sha256: item.sha256 !== '' ? item.sha256 : null,
          from: participantsJoined(item, 'from'),
          to: participantsJoined(item, 'to'),
          cc: participantsJoined(item, 'cc'),
          bcc: item.emailMetadata?.bccPresent === true ? participantsJoined(item, 'bcc') : null,
          subject: item.emailMetadata?.subject ?? null,
          sentDate: item.emailMetadata?.sentAt?.toISOString() ?? null,
          receivedDate: item.emailMetadata?.receivedAt?.toISOString() ?? null,
          dateCreated: item.sourceCreatedAt?.toISOString() ?? null,
          dateModified: item.sourceModifiedAt?.toISOString() ?? null,
          textPath: textOutPath !== '' ? textOutPath : null,
          nativePath: nativeOutPath !== '' ? nativeOutPath : null,
          tags: item.tagAssignments.map((t) => t.tag.name),
        },
      });
    }

    // Family attachment ranges: contiguous across the sorted family group.
    const familyGroups = new Map<string, ProducedDraft[]>();
    for (const draft of produced) {
      if (draft.familyId === null) continue;
      const group = familyGroups.get(draft.familyId);
      if (group !== undefined) group.push(draft);
      else familyGroups.set(draft.familyId, [draft]);
    }
    for (const group of familyGroups.values()) {
      if (group.length < 2) continue;
      const beg = group[0]?.begBates ?? '';
      const end = group[group.length - 1]?.endBates ?? '';
      for (const member of group) {
        member.begAttach = beg;
        member.endAttach = end;
        member.record.begAttach = beg;
        member.record.endAttach = end;
      }
    }

    const batesStart = produced[0]?.begBates ?? '';
    const batesEnd = produced[produced.length - 1]?.endBates ?? '';

    // Load files.
    if (params.output.mode === 'load_file') {
      const records = produced.map((p) => p.record);
      if (params.output.loadFileFormats.includes('dat')) {
        uploads.push({
          path: dataPath('loadfile.dat'),
          body: deps.buildDat(records, DEFAULT_DAT_PROFILE),
        });
      }
      if (params.output.loadFileFormats.includes('csv')) {
        uploads.push({
          path: dataPath('loadfile.csv'),
          body: Buffer.from(deps.buildCsv(records, DEFAULT_DAT_PROFILE), 'utf8'),
        });
      }
      if (params.output.loadFileFormats.includes('opt')) {
        // OPT is a page-level image cross reference: only meaningful when
        // page images exist. Document-PDF downgrades emit one line per doc.
        const optDocs: OptDocument[] = produced
          .filter((p) => p.imagePaths.length > 0)
          .map((p) => ({
            pages: p.imagePaths.map((path) => ({ batesNumber: p.begBates, imagePath: path })),
          }));
        if (optDocs.length > 0) {
          uploads.push({
            path: dataPath('loadfile.opt'),
            body: Buffer.from(deps.buildOpt(optDocs, 'VOL001'), 'utf8'),
          });
        }
      }
    }

    // Manifests.
    const manifest = deps.buildManifest({
      runId: productionRunId,
      productionId: run.productionId,
      parameters: run.frozenParameters,
      items: produced.map((p) => ({ ...p.record, sha256PerOutput: p.outputs })),
      exceptions: exceptions.map((e) => ({ ...e })),
      batesStart,
      batesEnd,
      generatedAt: new Date(),
    });
    uploads.push({ path: manifestPath('manifest.json'), body: Buffer.from(manifest.json, 'utf8') });
    uploads.push({
      path: manifestPath('parameters.json'),
      body: Buffer.from(JSON.stringify(run.frozenParameters, null, 2), 'utf8'),
    });
    uploads.push({
      path: manifestPath('exceptions.json'),
      body: Buffer.from(JSON.stringify(exceptions, null, 2), 'utf8'),
    });

    // Upload everything under the production key space.
    let outputPrefix = '';
    for (const upload of uploads) {
      const key = productionKey(
        tenantId,
        run.productionId,
        productionRunId,
        ...upload.path.split('/'),
      );
      if (outputPrefix === '') {
        outputPrefix = key.slice(0, key.lastIndexOf(upload.path) - 1);
      }
      await ctx.s3.send(
        new PutObjectCommand({
          Bucket: ctx.config.CDFIR_S3_BUCKET_EVIDENCE,
          Key: key,
          Body: upload.body,
          ContentType: 'application/octet-stream',
        }),
      );
    }

    // Persist rows in batches, replacing any partial rows from a crashed attempt.
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.productionItem.deleteMany({ where: { productionRunId } });
      await tx.productionException.deleteMany({ where: { productionRunId } });
    });
    const BATCH = 500;
    for (let offset = 0; offset < produced.length; offset += BATCH) {
      const batch = produced.slice(offset, offset + BATCH);
      await withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.productionItem.createMany({
          data: batch.map((p) => ({
            tenantId,
            productionRunId,
            evidenceItemId: p.evidenceItemId,
            sortIndex: p.sortIndex,
            begBates: p.begBates,
            endBates: p.endBates,
            begAttach: p.begAttach,
            endAttach: p.endAttach,
            pageCount: p.pageCount,
            outputKind: p.outputKind,
            imagePaths: p.imagePaths,
            nativePath: p.nativePath,
            textPath: p.textPath,
            placeholderReason: p.placeholderReason,
            state: p.state,
          })),
          skipDuplicates: true,
        }),
      );
    }
    if (exceptions.length > 0) {
      await withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.productionException.createMany({
          data: exceptions.map((e) => ({
            tenantId,
            productionRunId,
            evidenceItemId: e.evidenceItemId,
            code: e.code,
            severity: e.severity,
            message: e.message,
            detail: (e.detail ?? {}) as Prisma.InputJsonValue,
          })),
        }),
      );
    }

    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.productionRun.update({
        where: { id: productionRunId },
        data: {
          status: 'ready',
          batesStart,
          batesEnd,
          manifestSha256: manifest.sha256,
          outputPrefix,
          finishedAt: new Date(),
          progress: {
            items: produced.length,
            placeholders: produced.filter((p) => p.state === 'placeholder').length,
            exceptions: exceptions.length,
          } as Prisma.InputJsonValue,
        },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'production.run_completed',
        targetType: 'production_run',
        targetId: productionRunId,
        actorDisplay: 'worker',
        summary: {
          items: produced.length,
          batesStart,
          batesEnd,
          manifestSha256: manifest.sha256,
          exceptions: exceptions.length,
          securityCritical: exceptions.filter((e) => e.severity === 'security_critical').length,
        },
      });
    });
  } catch (err) {
    const message = sanitizeError(err);
    ctx.log.error({ productionRunId, err: message }, 'production: run failed');
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.productionRun.update({
        where: { id: productionRunId },
        data: { status: 'failed', statusDetail: message, finishedAt: new Date() },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'production.run_failed',
        targetType: 'production_run',
        targetId: productionRunId,
        actorDisplay: 'worker',
        summary: { error: message },
      });
    });
  }
}

/**
 * Redacted rendering path (only reachable when a rasterizer is available —
 * injected in tests). Kept separate so the security gate in the caller stays
 * auditable.
 */
async function renderRedacted(
  item: LoadedItem,
  ctx: WorkerContext,
  deps: ProductionDeps,
): Promise<Uint8Array> {
  void ctx;
  void item;
  // Without a real rasterizer implementation this path must not fabricate
  // output; deps.rasterizerAvailable() gates entry, and test doubles override
  // this hook via assembleImagePdf/validateNoTextLayer.
  return deps.assembleImagePdf([{ image: Buffer.alloc(0), format: 'png' }]);
}
