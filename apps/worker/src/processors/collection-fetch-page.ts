import { createHash } from 'node:crypto';
import {
  DeltaExpiredError,
  HistoryExpiredError,
  type DriveListPage,
  type EmailListPage,
} from '@aeg-clouddfir/connectors';
import { appendAuditEvent, withTenantContext, type Prisma } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import {
  buildConnectorsForAccount,
  makeRateLimitObserver,
  type ConnectorBundle,
} from '../connector-factory.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { dateRangeToInstants, parseCollectionScope } from '../scope.js';
import { DEFAULT_DRIVE_SCOPE_KEY } from './collection-discover.js';
import { processAuditFetchPage } from './collection-audit-fetch-page.js';
import type { DriveEntryPayload, FetchPagePayload } from './payloads.js';

export function cursorHash(cursor: string): string {
  return createHash('sha256').update(cursor, 'utf8').digest('hex').slice(0, 16);
}

type CheckpointKind = 'page' | 'delta' | 'history' | 'changes' | 'none';

/** Checkpoint kind once a scope's enumeration is exhausted. */
export function exhaustedCursorKind(
  provider: 'microsoft' | 'google',
  source: 'email' | 'drive',
  deltaCursor: string | undefined,
): CheckpointKind {
  if (deltaCursor === undefined || deltaCursor === '') return 'none';
  if (source === 'email') return provider === 'google' ? 'history' : 'delta';
  return provider === 'google' ? 'changes' : 'delta';
}

interface PageEntry {
  providerItemId: string;
  providerImmutableId: string;
  entry?: DriveEntryPayload;
}

interface ListedPage {
  entries: PageEntry[];
  nextCursor?: string;
  deltaCursor?: string;
}

async function listOnePage(
  bundle: ConnectorBundle,
  payload: FetchPagePayload,
  scopeRaw: unknown,
  checkpoint: { cursorKind: string; cursor: string },
): Promise<ListedPage> {
  const scope = parseCollectionScope(scopeRaw);
  const cursor = checkpoint.cursor === '' ? undefined : checkpoint.cursor;

  if (payload.source === 'email') {
    let page: EmailListPage;
    if (checkpoint.cursorKind === 'delta' || checkpoint.cursorKind === 'history') {
      page = await bundle.email.getMailDelta(bundle.custodianRef, payload.scopeKey, cursor);
    } else {
      const instants = dateRangeToInstants(scope);
      page = await bundle.email.listMessages(bundle.custodianRef, payload.scopeKey, {
        since: instants.since ?? undefined,
        until: instants.untilExclusive ?? undefined,
        includeDeleted: (scope.email?.includeSpam ?? false) || (scope.email?.includeTrash ?? false),
        cursor,
      });
    }
    return {
      entries: page.items
        .filter((m) => m.deleted !== true)
        .map((m) => ({
          providerItemId: m.providerItemId,
          providerImmutableId: m.providerImmutableId ?? '',
        })),
      nextCursor: page.nextCursor,
      deltaCursor: page.deltaCursor,
    };
  }

  let page: DriveListPage;
  if (checkpoint.cursorKind === 'delta' || checkpoint.cursorKind === 'changes') {
    page = await bundle.drive.getChangesDelta(bundle.custodianRef, cursor);
  } else {
    page = await bundle.drive.listFiles(bundle.custodianRef, {
      cursor,
      driveId: payload.scopeKey === DEFAULT_DRIVE_SCOPE_KEY ? undefined : payload.scopeKey,
      includeTrashed: scope.drive?.includeTrashed ?? false,
    });
  }
  const includeTrashed = scope.drive?.includeTrashed ?? false;
  return {
    entries: page.items
      .filter((entry) => !entry.isFolder && (includeTrashed || entry.trashed !== true))
      .map((entry) => ({
        providerItemId: entry.providerItemId,
        providerImmutableId: '',
        entry: { ...entry, checksums: entry.checksums ?? {} },
      })),
    nextCursor: page.nextCursor,
    deltaCursor: page.deltaCursor,
  };
}

/**
 * collection.fetch-page: list one provider page, persist the discovered items
 * and per-item fetch jobs, and advance the checkpoint — ALL in one tenant
 * transaction with a version guard, so a crash or a racing duplicate worker
 * can never skip or double-process a page.
 */
export async function processCollectionFetchPage(
  ctx: WorkerContext,
  payload: FetchPagePayload,
): Promise<void> {
  const { tenantId, collectionId, custodianId, source, scopeKey } = payload;

  // Audit is org-scoped and stages+persists records inline (no per-item fetch
  // stage), so it has a dedicated page processor.
  if (source === 'audit') {
    await processAuditFetchPage(ctx, payload);
    return;
  }

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
    const custodian = await tx.custodian.findUnique({ where: { id: custodianId } });
    return { collection, checkpoint, custodian };
  });

  if (loaded === null || loaded.checkpoint === null || loaded.custodian === null) {
    ctx.log.warn({ collectionId, custodianId, scopeKey }, 'fetch-page: missing state; dropping');
    return;
  }
  if (loaded.collection.status !== 'fetching') {
    // paused / cancelling / cancelled / failed / finalizing: bail quietly.
    return;
  }
  const { checkpoint, custodian } = loaded;

  const bundle = await buildConnectorsForAccount(ctx, {
    tenantId,
    connectorAccountId: loaded.collection.connectorAccountId,
    custodian: { externalId: custodian.externalId, email: custodian.email },
    onRateLimit: makeRateLimitObserver(ctx, tenantId, collectionId, custodianId, source),
  });

  let page: ListedPage;
  try {
    page = await listOnePage(bundle, payload, loaded.collection.scope, checkpoint);
  } catch (err) {
    if (err instanceof DeltaExpiredError || err instanceof HistoryExpiredError) {
      await handleExpiredCheckpoint(ctx, payload, checkpoint.id, checkpoint.version, err);
      return;
    }
    throw err;
  }

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    // 1. Persist items; the unique constraint is the dedup spine.
    let newCount = 0;
    if (page.entries.length > 0) {
      const created = await tx.collectionItem.createMany({
        data: page.entries.map((entry) => ({
          tenantId,
          collectionId,
          custodianId,
          source,
          providerItemId: entry.providerItemId,
          providerImmutableId: entry.providerImmutableId,
          state: 'discovered',
        })),
        skipDuplicates: true,
      });
      newCount = created.count;
    }

    // 2. Enqueue fetch-item work for entries still pending (or retryable-failed).
    const pageIds = page.entries.map((e) => e.providerItemId);
    const pending =
      pageIds.length > 0
        ? await tx.collectionItem.findMany({
            where: {
              collectionId,
              custodianId,
              source,
              providerItemId: { in: pageIds },
              state: { in: ['discovered', 'failed'] },
            },
            select: { providerItemId: true, attempts: true },
          })
        : [];
    if (pending.length > 0) {
      const entriesById = new Map(page.entries.map((e) => [e.providerItemId, e]));
      const outboxRows: Prisma.OutboxEventCreateManyInput[] = pending.map((item) => ({
        tenantId,
        topic: QUEUES.collectionFetchItem,
        dedupKey:
          dedupKeys.collectionFetchItem(collectionId, custodianId, source, item.providerItemId) +
          `:a${item.attempts}`,
        payload: {
          tenantId,
          collectionId,
          custodianId,
          source,
          providerItemId: item.providerItemId,
          ...(source === 'drive' ? { entry: entriesById.get(item.providerItemId)?.entry } : {}),
        } as Prisma.InputJsonValue,
      }));
      await tx.outboxEvent.createMany({ data: outboxRows, skipDuplicates: true });
    }

    if (newCount > 0) {
      await incrementProgress(tx, collectionId, custodianId, source, { discovered: newCount });
    }

    // 3. Advance the checkpoint monotonically. A stale version means another
    //    worker already advanced past this page: stop without enqueuing more.
    const exhausted = page.nextCursor === undefined;
    const nextKind: CheckpointKind = exhausted
      ? exhaustedCursorKind(bundle.provider, source, page.deltaCursor)
      : checkpoint.cursorKind === 'delta' ||
          checkpoint.cursorKind === 'history' ||
          checkpoint.cursorKind === 'changes'
        ? (checkpoint.cursorKind as CheckpointKind)
        : 'page';
    const nextCursorValue = exhausted ? (page.deltaCursor ?? '') : (page.nextCursor ?? '');

    const advanced = await tx.collectionCheckpoint.updateMany({
      where: { id: checkpoint.id, version: checkpoint.version },
      data: { cursor: nextCursorValue, cursorKind: nextKind, version: checkpoint.version + 1 },
    });
    if (advanced.count === 0) {
      return; // stale: a newer version exists; the other worker owns continuation.
    }

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
      // This scope is done: schedule a finalize check (tolerant of repeats).
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
 * A provider delta/history checkpoint expired: record the exception, reset
 * the checkpoint to a full rescan, and re-enqueue the start page. This is the
 * documented reconciliation path — never silent.
 */
async function handleExpiredCheckpoint(
  ctx: WorkerContext,
  payload: FetchPagePayload,
  checkpointId: string,
  loadedVersion: number,
  err: Error,
): Promise<void> {
  const { tenantId, collectionId, custodianId, source, scopeKey } = payload;
  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await recordException(tx, {
      tenantId,
      collectionId,
      custodianId,
      source,
      kind: 'expired_checkpoint',
      message: sanitizeError(err),
      detail: { scopeKey },
    });
    const reset = await tx.collectionCheckpoint.updateMany({
      where: { id: checkpointId, version: loadedVersion },
      data: { cursor: '', cursorKind: 'page', version: loadedVersion + 1 },
    });
    if (reset.count === 0) return; // someone else already reset it
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
            `rescan:${loadedVersion + 1}`,
          ),
          payload: { tenantId, collectionId, custodianId, source, scopeKey },
        },
      ],
      skipDuplicates: true,
    });
    await appendAuditEvent(tx, {
      tenantId,
      action: 'collection.reconciliation_started',
      targetType: 'collection',
      targetId: collectionId,
      actorDisplay: 'worker',
      summary: { custodianId, source, scopeKey, reason: 'expired_checkpoint' },
    });
  });
}
