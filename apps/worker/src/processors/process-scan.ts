import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { appendAuditEvent, withTenantContext } from '@aeg-clouddfir/database';
import { ClamdClient, type ClamAvClient } from '../clamav.js';
import { sanitizeError, type WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import type { EvidenceStagePayload } from './payloads.js';

export interface ScanDeps {
  clamFactory?: (ctx: WorkerContext) => ClamAvClient;
}

/**
 * process.scan: ClamAV INSTREAM malware scan. NEVER crashes the pipeline —
 * an unreachable or disabled scanner records an honest scan_failed result.
 * Infected items are marked and (when no other evidence item shares the
 * blob) the object is copied to the quarantine bucket; the evidence original
 * is deleted best-effort only, respecting possible Object Lock retention.
 */
export async function processScan(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  deps: ScanDeps = {},
): Promise<void> {
  const { tenantId, evidenceItemId } = payload;
  const version = payload.version;

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: { blob: true, malwareScans: { select: { id: true }, take: 1 } },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'scan: evidence item not found; dropping');
    return;
  }
  if (item.malwareScans.length > 0) return; // already scanned (idempotent)

  const finishWithResult = async (
    result: 'clean' | 'infected' | 'scan_failed',
    engine: { engineVersion: string; signatureVersion: string },
    signatureName: string,
  ): Promise<void> => {
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.malwareScan.create({
        data: {
          tenantId,
          evidenceItemId,
          engineName: 'clamav',
          engineVersion: engine.engineVersion,
          signatureVersion: engine.signatureVersion,
          result,
          signatureName,
        },
      });
      await tx.evidenceItem.update({
        where: { id: evidenceItemId },
        data: { malwareStatus: result },
      });
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: QUEUES.searchIndex,
            dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'scan'),
            payload: { tenantId, evidenceItemId, version },
          },
        ],
        skipDuplicates: true,
      });
    });
  };

  if (!ctx.config.CDFIR_CLAMAV_ENABLED) {
    await finishWithResult('scan_failed', { engineVersion: 'disabled', signatureVersion: '' }, '');
    return;
  }
  if (item.blob === null) {
    await finishWithResult('scan_failed', { engineVersion: '', signatureVersion: '' }, '');
    return;
  }
  const blob = item.blob;

  const clam =
    deps.clamFactory !== undefined
      ? deps.clamFactory(ctx)
      : new ClamdClient(ctx.config.CDFIR_CLAMAV_HOST, ctx.config.CDFIR_CLAMAV_PORT);

  let engine = { engineVersion: '', signatureVersion: '' };
  let scan: { infected: boolean; signature: string };
  try {
    engine = await clam.version();
    const stream = await ctx.store.getStream(
      blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
      blob.objectKey,
    );
    scan = await clam.scanStream(stream);
  } catch (err) {
    ctx.log.warn({ evidenceItemId, err: sanitizeError(err) }, 'scan: clamav unavailable');
    await finishWithResult('scan_failed', engine, '');
    return;
  }

  if (!scan.infected) {
    await finishWithResult('clean', engine, '');
    return;
  }

  // Infected. Dedup safety: only physically quarantine the object when no
  // OTHER evidence item shares the blob.
  const sharedCount = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.count({
      where: { blobId: blob.id, id: { not: evidenceItemId } },
    }),
  );

  let objectMoved = false;
  let originalDeleted = false;
  let quarantineKey = '';
  if (sharedCount === 0 && blob.storageClass !== 'quarantine') {
    const source = await ctx.store.getStream('evidence', blob.objectKey);
    const staged = await ctx.store.stageStream(tenantId, source);
    const promoted = await ctx.store.promoteToOriginal(
      tenantId,
      staged.stagingKey,
      { sha256: staged.sha256, size: staged.size },
      { quarantine: true },
    );
    quarantineKey = promoted.objectKey;
    objectMoved = true;
    // Best-effort delete of the evidence-bucket original. Object Lock (when
    // enabled) can legitimately refuse — the outcome is recorded honestly.
    try {
      await ctx.s3.send(
        new DeleteObjectCommand({
          Bucket: ctx.config.CDFIR_S3_BUCKET_EVIDENCE,
          Key: blob.objectKey,
        }),
      );
      originalDeleted = true;
    } catch {
      originalDeleted = false;
    }
  }

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.malwareScan.create({
      data: {
        tenantId,
        evidenceItemId,
        engineName: 'clamav',
        engineVersion: engine.engineVersion,
        signatureVersion: engine.signatureVersion,
        result: 'infected',
        signatureName: scan.signature,
      },
    });
    await tx.evidenceItem.update({
      where: { id: evidenceItemId },
      data: { malwareStatus: 'infected' },
    });
    if (objectMoved) {
      await tx.evidenceBlob.update({
        where: { id: blob.id },
        data: { storageClass: 'quarantine', objectKey: quarantineKey },
      });
    }
    if (item.collectionId !== null) {
      await recordException(tx, {
        tenantId,
        collectionId: item.collectionId,
        custodianId: item.custodianId ?? undefined,
        providerItemId: item.providerItemId,
        kind: 'quarantined',
        message: `malware detected: ${scan.signature}`,
        detail: { objectMoved, sharedBlob: sharedCount > 0 },
      });
    }
    await appendAuditEvent(tx, {
      tenantId,
      action: 'evidence.quarantined',
      targetType: 'evidence_item',
      targetId: evidenceItemId,
      actorDisplay: 'worker',
      summary: {
        signature: scan.signature,
        objectMoved,
        originalDeleted,
        sharedBlob: sharedCount > 0,
        engineVersion: engine.engineVersion,
        signatureVersion: engine.signatureVersion,
      },
    });
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'scan'),
          payload: { tenantId, evidenceItemId, version },
        },
      ],
      skipDuplicates: true,
    });
  });
}
