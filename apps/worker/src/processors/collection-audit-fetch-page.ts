import { Readable } from 'node:stream';
import { AuditConfigError, ProviderApiError, type AuditListPage } from '@evidencevault/connectors';
import { appendAuditEvent, withTenantContext, type Prisma } from '@evidencevault/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { buildAuditConnectors, makeRateLimitObserver } from '../connector-factory.js';
import {
  AuditRequiresOrganizationModeError,
  parseAuditScopeKey,
  type AuditConnectorBundle,
} from '../audit.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { cursorHash } from './collection-fetch-page.js';
import { dateRangeToInstants, parseCollectionScope } from '../scope.js';
import type { FetchPagePayload } from './payloads.js';

function parseDate(value: string | undefined): Date | null {
  if (value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * collection.fetch-page (source='audit'): fetch one provider page of audit
 * batches for a scope, preserve each batch's raw bytes as an audit_batch
 * evidence item, insert the parsed AuditRecord rows (idempotent via the unique
 * [tenantId, system, providerRecordId]), and advance the checkpoint — all under
 * a single version-guarded tenant transaction so a crash or a racing worker can
 * never double-persist or skip a page. A per-scope 403 (auditing not enabled /
 * insufficient permission) is recorded as a permission_denied exception and
 * exhausts the scope rather than failing the whole collection.
 */
export async function processAuditFetchPage(
  ctx: WorkerContext,
  payload: FetchPagePayload,
): Promise<void> {
  const { tenantId, collectionId, custodianId, source, scopeKey } = payload;

  const loaded = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const collection = await tx.collection.findUnique({
      where: { id: collectionId },
      select: { status: true, scope: true, connectorAccountId: true },
    });
    if (collection === null) return null;
    const checkpoint = await tx.collectionCheckpoint.findUnique({
      where: {
        collectionId_custodianId_source_scopeKey: { collectionId, custodianId, source, scopeKey },
      },
    });
    const connectorAccount = await tx.connectorAccount.findUnique({
      where: { id: collection.connectorAccountId },
      select: { provider: true },
    });
    return { collection, checkpoint, connectorAccount };
  });

  if (loaded === null || loaded.checkpoint === null) {
    ctx.log.warn({ collectionId, scopeKey }, 'audit fetch-page: missing state; dropping');
    return;
  }
  if (loaded.collection.status !== 'fetching') return; // paused/cancelling: bail quietly
  const { checkpoint } = loaded;
  const provider = loaded.connectorAccount?.provider ?? null;

  const scope = parseCollectionScope(loaded.collection.scope);
  const instants = dateRangeToInstants(scope);
  const actorFilter = scope.audit?.actorFilter ?? [];
  const { kind, scopeKey: rawScopeKey } = parseAuditScopeKey(scopeKey);

  let bundle: AuditConnectorBundle;
  try {
    bundle = await buildAuditConnectors(ctx, {
      tenantId,
      connectorAccountId: loaded.collection.connectorAccountId,
      auditScope: scope.audit,
      onRateLimit: makeRateLimitObserver(ctx, tenantId, collectionId, custodianId, 'audit'),
    });
  } catch (err) {
    const permission = err instanceof AuditRequiresOrganizationModeError;
    await exhaustWithException(ctx, payload, checkpoint.id, checkpoint.version, {
      kind: permission ? 'permission_denied' : 'api_error',
      message: sanitizeError(err),
    });
    return;
  }

  const tagged = bundle.connectors.find((c) => c.kind === kind);
  if (tagged === undefined) {
    await exhaustWithException(ctx, payload, checkpoint.id, checkpoint.version, {
      kind: 'unsupported_item',
      message: `no audit connector available for '${kind}'`,
    });
    return;
  }

  let page: AuditListPage;
  try {
    page = await tagged.connector.fetchAuditPage(rawScopeKey, {
      since: instants.since ?? undefined,
      until: instants.untilExclusive ?? undefined,
      cursor: checkpoint.cursor === '' ? undefined : checkpoint.cursor,
      actorFilter: actorFilter.length > 0 ? actorFilter : undefined,
    });
  } catch (err) {
    // Per-scope 403: auditing not enabled or insufficient permission. Treat as
    // a scope limitation, not a hard failure.
    if (err instanceof ProviderApiError && err.status === 403) {
      await exhaustWithException(ctx, payload, checkpoint.id, checkpoint.version, {
        kind: 'permission_denied',
        message: `audit scope '${kind}/${rawScopeKey}' unavailable (403): ${sanitizeError(err)}`,
      });
      return;
    }
    // A required audit setup value is missing/invalid (e.g. one-sided window,
    // subscription not enabled): record and skip the scope, do not hard-fail.
    if (err instanceof AuditConfigError) {
      await exhaustWithException(ctx, payload, checkpoint.id, checkpoint.version, {
        kind: 'unsupported_item',
        message: `audit scope '${kind}/${rawScopeKey}' misconfigured: ${sanitizeError(err)}`,
      });
      return;
    }
    throw err;
  }

  // Stage every batch's raw bytes OUTSIDE the transaction (content-addressed,
  // safe to repeat). Records the sha/size/objectKey for the DB writes.
  const staged = await Promise.all(
    page.batches.map(async (batch) => {
      const result = await ctx.store.stageStream(
        tenantId,
        Readable.from(Buffer.from(batch.rawBytes)),
      );
      const promoted = await ctx.store.promoteToOriginal(
        tenantId,
        result.stagingKey,
        { sha256: result.sha256, size: result.size },
        { quarantine: false },
      );
      return { batch, sha256: result.sha256, size: result.size, objectKey: promoted.objectKey };
    }),
  );

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    // 1. Version-guarded checkpoint advance FIRST: this is the mutual-exclusion
    //    token for the page, so exactly one worker performs the evidence writes.
    const exhausted = page.nextCursor === undefined;
    const nextCursorValue = exhausted ? '' : (page.nextCursor ?? '');
    const advanced = await tx.collectionCheckpoint.updateMany({
      where: { id: checkpoint.id, version: checkpoint.version },
      data: {
        cursor: nextCursorValue,
        cursorKind: exhausted ? 'none' : 'page',
        version: checkpoint.version + 1,
      },
    });
    if (advanced.count === 0) return; // stale: another worker owns this page

    let observedRecords = 0;
    let reportedRecords = 0;

    for (const { batch, sha256, size, objectKey } of staged) {
      const batchProviderId = `${batch.system}/${batch.scopeKey}/${batch.batchId}`;

      // dedup spine: one collection item per batch. If it already exists in a
      // terminal state, the batch was persisted by a prior run — skip it.
      const created = await tx.collectionItem.createMany({
        data: [
          {
            tenantId,
            collectionId,
            custodianId,
            source,
            providerItemId: batchProviderId,
            state: 'discovered',
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0) continue; // already processed

      await tx.evidenceBlob.createMany({
        data: [{ tenantId, sha256, size: BigInt(size), objectKey }],
        skipDuplicates: true,
      });
      const blob = await tx.evidenceBlob.findUniqueOrThrow({
        where: { tenantId_sha256: { tenantId, sha256 } },
        select: { id: true },
      });

      const occurredDates = batch.records
        .map((r) => parseDate(r.occurredAt))
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
      const primaryDate = occurredDates[0] ?? new Date();

      const evidence = await tx.evidenceItem.create({
        data: {
          tenantId,
          custodianId,
          collectionId,
          blobId: blob.id,
          kind: 'audit_batch',
          name: `${batch.system}/${batch.scopeKey}/${batch.batchId}.json`.slice(0, 500),
          extension: 'json',
          mimeType: 'application/json',
          size: BigInt(size),
          sha256,
          provider,
          providerItemId: batchProviderId,
          sourcePath: `${batch.system}/${batch.scopeKey}`,
          primaryDate,
          acquiredAt: new Date(),
        },
        select: { id: true },
      });

      if (batch.records.length > 0) {
        await tx.auditRecord.createMany({
          data: batch.records.map((record) => ({
            tenantId,
            evidenceItemId: evidence.id,
            collectionId,
            provider: provider ?? 'microsoft',
            system: record.system,
            providerRecordId: record.providerRecordId,
            workload: record.workload ?? '',
            operation: record.operation ?? '',
            recordType: record.recordType ?? '',
            actorId: record.actorId ?? '',
            actorEmail: record.actorEmail ?? '',
            actorIp: record.actorIp ?? '',
            targetId: record.targetId ?? '',
            targetType: record.targetType ?? '',
            resultStatus: record.resultStatus ?? '',
            occurredAt: parseDate(record.occurredAt),
            raw: (record.raw ?? {}) as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
      }

      await tx.collectionItem.update({
        where: {
          collectionId_custodianId_source_providerItemId: {
            collectionId,
            custodianId,
            source,
            providerItemId: batchProviderId,
          },
        },
        data: { state: 'preserved', evidenceItemId: evidence.id, lastError: '' },
      });

      await appendAuditEvent(tx, {
        tenantId,
        action: 'evidence.acquired',
        targetType: 'evidence_item',
        targetId: evidence.id,
        actorDisplay: 'worker',
        summary: {
          sha256,
          size,
          system: batch.system,
          scopeKey: batch.scopeKey,
          batchId: batch.batchId,
          recordCount: batch.records.length,
          collectionId,
        },
      });

      // Batch-level search doc (one per batch); records drill-in is via the API.
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: QUEUES.searchIndex,
            dedupKey: dedupKeys.searchIndex(evidence.id, 1, 'audit'),
            payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
          },
        ],
        skipDuplicates: true,
      });

      observedRecords += batch.records.length;
      if (batch.providerReportedCount !== undefined) reportedRecords += batch.providerReportedCount;

      await incrementProgress(tx, collectionId, custodianId, 'audit', {
        discovered: 1,
        fetched: 1,
        preserved: 1,
      });

      // Honesty: surface any gap between what the provider reported and what we
      // actually persisted for the batch.
      if (
        batch.providerReportedCount !== undefined &&
        batch.providerReportedCount !== batch.records.length
      ) {
        await recordException(tx, {
          tenantId,
          collectionId,
          custodianId,
          source,
          providerItemId: batchProviderId,
          kind: 'other',
          message: `provider reported ${batch.providerReportedCount} audit record(s) but ${batch.records.length} were observed`,
          detail: {
            reported: batch.providerReportedCount,
            observed: batch.records.length,
            system: batch.system,
          },
        });
      }
    }

    ctx.log.info(
      { collectionId, scopeKey, observedRecords, reportedRecords },
      'audit fetch-page: batch page persisted',
    );

    // 2. Continue paging or schedule a finalize check.
    if (!exhausted) {
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: QUEUES.collectionFetchPage,
            dedupKey: dedupKeys.collectionFetchPage(
              collectionId,
              custodianId,
              source,
              scopeKey,
              cursorHash(page.nextCursor ?? ''),
            ),
            payload: { tenantId, collectionId, custodianId, source, scopeKey },
          },
        ],
        skipDuplicates: true,
      });
    } else {
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: QUEUES.collectionFinalize,
            dedupKey: `${dedupKeys.collectionFinalize(collectionId)}:chk:${scopeKey}`,
            payload: { tenantId, collectionId },
          },
        ],
        skipDuplicates: true,
      });
    }
  });
}

/**
 * Record an exception for the scope, mark its checkpoint exhausted (so the
 * collection can finalize), and schedule a finalize check. Used for
 * delegated-mode misconfiguration and per-scope permission/availability errors.
 */
async function exhaustWithException(
  ctx: WorkerContext,
  payload: FetchPagePayload,
  checkpointId: string,
  loadedVersion: number,
  exception: {
    kind: 'permission_denied' | 'api_error' | 'unsupported_item';
    message: string;
  },
): Promise<void> {
  const { tenantId, collectionId, custodianId, source, scopeKey } = payload;
  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await recordException(tx, {
      tenantId,
      collectionId,
      custodianId,
      source,
      kind: exception.kind,
      message: exception.message,
      detail: { scopeKey },
    });
    const reset = await tx.collectionCheckpoint.updateMany({
      where: { id: checkpointId, version: loadedVersion },
      data: { cursor: '', cursorKind: 'none', version: loadedVersion + 1 },
    });
    if (reset.count === 0) return;
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          topic: QUEUES.collectionFinalize,
          dedupKey: `${dedupKeys.collectionFinalize(collectionId)}:chk:${scopeKey}`,
          payload: { tenantId, collectionId },
        },
      ],
      skipDuplicates: true,
    });
  });
}
