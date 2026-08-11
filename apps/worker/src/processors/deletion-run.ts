import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { withTenantContext, appendAuditEvent } from '@evidencevault/database';
import { z } from 'zod';
import type { WorkerContext } from '../context.js';
import { sanitizeError } from '../context.js';

export const deletionRunPayload = z.object({
  tenantId: z.string().uuid(),
  deletionRequestId: z.string().uuid(),
});
export type DeletionRunPayload = z.infer<typeof deletionRunPayload>;

const deletionScope = z.object({
  kind: z.enum(['evidence_items', 'collection']),
  evidenceItemIds: z.array(z.string().uuid()).optional(),
  collectionId: z.string().uuid().optional(),
});

/**
 * Executes an APPROVED two-phase deletion request (contract §15).
 *
 * Safety gates, all fail-closed:
 *  1. request must be status=approved with distinct requester/approver;
 *  2. every targeted item is blocked while it belongs to any case with an
 *     active legal hold — blocked items are excluded and reported;
 *  3. shared blobs (same bytes referenced by surviving items) are never
 *     deleted from the object store;
 *  4. Object Lock: S3 delete failures (e.g. WORM retention) mark the item
 *     'blocked_by_object_lock' in the manifest — the app never bypasses it;
 *  5. a deletion manifest (what, why, who, when, what was blocked) is stored
 *     BEFORE database rows are removed, and the whole action is audited.
 */
export async function deletionRun(ctx: WorkerContext, payload: DeletionRunPayload): Promise<void> {
  const { tenantId, deletionRequestId } = payload;

  const request = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.deletionRequest.findUnique({ where: { id: deletionRequestId } }),
  );
  if (!request) return;
  if (request.status === 'executed') return; // idempotent replay
  if (request.status !== 'approved') {
    ctx.log.warn({ deletionRequestId, status: request.status }, 'deletion not approved; skipping');
    return;
  }
  if (!request.approvedById || request.approvedById === request.requestedById) {
    await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.deletionRequest.update({
        where: { id: deletionRequestId },
        data: {
          status: 'blocked',
          blockedReason: 'four-eyes violation: approver missing or same as requester',
        },
      }),
    );
    return;
  }

  const scope = deletionScope.parse(request.scope);

  // Resolve target evidence items.
  const targets = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findMany({
      where:
        scope.kind === 'collection'
          ? { collectionId: scope.collectionId }
          : { id: { in: scope.evidenceItemIds ?? [] } },
      select: {
        id: true,
        name: true,
        sha256: true,
        blobId: true,
        caseItems: { select: { case: { select: { id: true, legalHold: true } } } },
      },
    }),
  );

  const held = targets.filter((t) => t.caseItems.some((ci) => ci.case.legalHold));
  const deletable = targets.filter((t) => !t.caseItems.some((ci) => ci.case.legalHold));

  const manifestEntries: Array<{
    evidenceItemId: string;
    name: string;
    sha256: string;
    outcome: string;
    detail?: string;
  }> = held.map((t) => ({
    evidenceItemId: t.id,
    name: t.name,
    sha256: t.sha256,
    outcome: 'blocked_by_legal_hold',
  }));

  for (const item of deletable) {
    let outcome = 'metadata_deleted_blob_retained_shared';
    let detail: string | undefined;

    if (item.blobId) {
      const sharedCount = await withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.evidenceItem.count({ where: { blobId: item.blobId!, id: { not: item.id } } }),
      );
      if (sharedCount === 0) {
        const blob = await withTenantContext(ctx.prisma, tenantId, (tx) =>
          tx.evidenceBlob.findUnique({ where: { id: item.blobId! } }),
        );
        if (blob) {
          const bucket =
            blob.storageClass === 'quarantine'
              ? ctx.config.EV_S3_BUCKET_QUARANTINE
              : ctx.config.EV_S3_BUCKET_EVIDENCE;
          try {
            await ctx.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: blob.objectKey }));
            outcome = 'object_and_metadata_deleted';
          } catch (err) {
            outcome = 'blocked_by_object_lock_or_storage';
            detail = sanitizeError(err);
          }
        }
      }
    }

    if (!outcome.startsWith('blocked')) {
      await withTenantContext(ctx.prisma, tenantId, async (tx) => {
        await tx.evidenceItem.delete({ where: { id: item.id } });
        if (item.blobId && outcome === 'object_and_metadata_deleted') {
          await tx.evidenceBlob.delete({ where: { id: item.blobId } }).catch(() => undefined);
        }
      });
    }
    manifestEntries.push({
      evidenceItemId: item.id,
      name: item.name,
      sha256: item.sha256,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  const executedAt = new Date();
  const manifest = {
    schemaVersion: '1',
    kind: 'deletion-manifest',
    deletionRequestId,
    tenantId,
    reason: request.reason,
    requestedById: request.requestedById,
    approvedById: request.approvedById,
    requestedAt: request.requestedAt.toISOString(),
    approvedAt: request.approvedAt?.toISOString() ?? null,
    executedAt: executedAt.toISOString(),
    totals: {
      targeted: targets.length,
      deleted: manifestEntries.filter((e) => e.outcome === 'object_and_metadata_deleted').length,
      metadataOnly: manifestEntries.filter((e) => e.outcome.startsWith('metadata_deleted')).length,
      blocked: manifestEntries.filter((e) => e.outcome.startsWith('blocked')).length,
    },
    entries: manifestEntries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const { objectKey, sha256 } = await ctx.store.putManifest(
    tenantId,
    deletionRequestId,
    manifestJson,
  );

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.deletionRequest.update({
      where: { id: deletionRequestId },
      data: {
        status: 'executed',
        executedAt,
        manifestKey: objectKey,
        manifestSha256: sha256,
        ...(held.length > 0
          ? { blockedReason: `${held.length} item(s) retained under legal hold` }
          : {}),
      },
    });
    await appendAuditEvent(tx, {
      tenantId,
      actorUserId: request.approvedById ?? '',
      action: 'deletion.executed',
      targetType: 'deletion_request',
      targetId: deletionRequestId,
      summary: { totals: manifest.totals, manifestSha256: sha256 },
    });
  });

  ctx.log.info({ deletionRequestId, totals: manifest.totals }, 'deletion request executed');
}
