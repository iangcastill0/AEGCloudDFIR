import type { Readable } from 'node:stream';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { appendAuditEvent, Prisma, withTenantContext } from '@aeg-clouddfir/database';
import { ClamdClient, type ClamAvClient } from '../clamav.js';
import { sanitizeError, type WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { isObjectNotFoundError, recordMissingObject } from './missing-object.js';
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
 *
 * An object that is not in storage is NOT a scan failure and is not recorded
 * as one. See ./missing-object.ts.
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
      include: {
        blob: true,
        malwareScans: {
          select: { id: true, result: true },
          orderBy: { scannedAt: 'desc' },
          take: 1,
        },
        sourceForImport: { select: { id: true } },
      },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'scan: evidence item not found; dropping');
    return;
  }
  if (item.malwareScans.length > 0 && item.malwareScans[0]?.result !== 'scan_failed') return;

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
      const outboxRows: Prisma.OutboxEventCreateManyInput[] = [];
      if (typeof item.importId !== 'string') {
        outboxRows.push({
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'scan'),
          payload: { tenantId, evidenceItemId, version },
        });
      } else if (item.sourceForImport !== null && item.sourceForImport !== undefined) {
        outboxRows.push({
          tenantId,
          topic: QUEUES.importAnalyze,
          dedupKey: dedupKeys.importAnalyze(item.sourceForImport.id),
          payload: { tenantId, importId: item.sourceForImport.id },
        });
      } else if (result === 'clean' || !ctx.config.CDFIR_CLAMAV_ENABLED) {
        outboxRows.push(
          {
            tenantId,
            topic: QUEUES.processExtract,
            dedupKey: dedupKeys.processStage('extract', evidenceItemId, version),
            payload: { tenantId, evidenceItemId, version },
          },
          {
            tenantId,
            topic: QUEUES.processPreview,
            dedupKey: dedupKeys.processStage('preview', evidenceItemId, version),
            payload: { tenantId, evidenceItemId, version },
          },
          {
            tenantId,
            topic: QUEUES.searchIndex,
            dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'import-scan'),
            payload: { tenantId, evidenceItemId, version },
          },
        );
      } else {
        await tx.forensicImport.update({
          where: { id: item.importId },
          data: { status: 'failed', error: 'an extracted member malware scan did not complete' },
        });
        await appendAuditEvent(tx, {
          tenantId,
          action: 'import.analysis_failed',
          targetType: 'forensic_import',
          targetId: item.importId,
          actorDisplay: 'worker',
          summary: {
            error: 'an extracted member malware scan did not complete',
            evidenceItemId,
          },
        });
      }
      if (outboxRows.length > 0) {
        await tx.outboxEvent.createMany({
          data: outboxRows,
          skipDuplicates: true,
        });
      }
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

  const bucket =
    blob.storageClass === 'quarantine' ? ('quarantine' as const) : ('evidence' as const);

  // Three separate things used to share one try/catch: asking clamd its
  // version, reading the object, and scanning it. Every failure came out as
  // scan_failed logged 'clamav unavailable', so "the scanner is down" and "the
  // evidence is gone" were the same sentence — and the alarming one wore the
  // reassuring one's words. They are told apart here, one step at a time.

  let engine = { engineVersion: '', signatureVersion: '' };
  try {
    engine = await clam.version();
  } catch (err) {
    // Genuinely the scanner. Unchanged on purpose: a ClamAV restart must stay
    // an ordinary, retryable scan_failed and must not raise an evidence alarm.
    ctx.log.warn({ evidenceItemId, err: sanitizeError(err) }, 'scan: clamav unavailable');
    await finishWithResult('scan_failed', engine, '');
    return;
  }

  let stream: Readable;
  try {
    stream = await ctx.store.getStream(bucket, blob.objectKey);
  } catch (err) {
    if (isObjectNotFoundError(err)) {
      // No MalwareScan row. Writing one would satisfy the idempotency guard at
      // the top of this function, so a retry after the bytes are restored from
      // a bucket version would return early and the item would stay unscanned
      // forever. There was no scan; recording one would be a fiction.
      await recordMissingObject(ctx, {
        tenantId,
        item,
        version,
        stage: 'scan',
        bucket,
        objectKey: blob.objectKey,
        malwareUnscannable: true,
      });
      return;
    }
    // Storage is reachable but this read failed (timeout, 5xx, denied). Still
    // scan_failed and still retryable, but never in clamav's name.
    ctx.log.warn(
      { evidenceItemId, err: sanitizeError(err) },
      'scan: could not read the evidence object from storage',
    );
    await finishWithResult('scan_failed', engine, '');
    return;
  }

  let scan: { infected: boolean; signature: string };
  try {
    scan = await clam.scanStream(stream);
  } catch (err) {
    ctx.log.warn({ evidenceItemId, err: sanitizeError(err) }, 'scan: clamav scan failed');
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
    if (typeof item.importId === 'string') {
      await tx.forensicImport.update({
        where: { id: item.importId },
        data: { status: 'failed', error: 'source was quarantined as malware' },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'import.analysis_failed',
        targetType: 'forensic_import',
        targetId: item.importId,
        actorDisplay: 'worker',
        summary: { error: 'source was quarantined as malware', signature: scan.signature },
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
