/**
 * Record a job failure that the processor's own catch never saw.
 *
 * A processor that throws records its own failure: it marks the collection item,
 * writes an exception row and bumps the ledger. A STALLED job never gets that
 * far. The worker was killed mid-execution, so no catch ran; BullMQ later fails
 * the job from outside the handler.
 *
 * That happened on staging. A deploy restarted the worker at 20:22:03, eight
 * fetch-item jobs were in flight, and all eight failed as stalled. Their rows
 * stayed `state = fetching` for twenty hours: the collection could never
 * finalize, the page reported "Failures 0", and "Retry failed items" had nothing
 * to retry because nothing was recorded as failed.
 *
 * The pure parts are separated so the rules are testable without a queue.
 */
import { withTenantContext } from '@aeg-clouddfir/database';
import type { WorkerContext } from './context.js';
import { incrementProgress, recordException } from './progress.js';
import { QUEUES, type QueueName } from './queues.js';

/** BullMQ's own wording when a job's lock expires and it gives up. */
export const STALLED_REASON = 'job stalled more than allowable limit';

/**
 * A stalled job is terminal on its FIRST failure, whatever the retry budget
 * says. BullMQ has already stopped retrying it by the time this message
 * appears, so waiting for attemptsMade to reach the limit means waiting forever.
 */
export function isTerminalFailure(input: {
  reason: string;
  attemptsMade: number;
  attempts: number;
}): boolean {
  if (input.reason.includes(STALLED_REASON)) return true;
  return input.attemptsMade >= input.attempts;
}

export interface CollectionItemTarget {
  kind: 'collection-item';
  tenantId: string;
  collectionId: string;
  custodianId: string;
  source: 'email' | 'drive' | 'chat' | 'audit';
  providerItemId: string;
}

export interface EvidenceItemTarget {
  kind: 'evidence-item';
  tenantId: string;
  evidenceItemId: string;
  /**
   * process.extract has no stall-sweeper recovery. A death leaves the item
   * `pending`, finalize does not wait on file extract, and Retry only
   * reindexes collection items that already have bytes — so the once-ever
   * extract key stays burned and the file never becomes searchable.
   * Mark exception so Retry re-queues extract. process.parse must stay
   * pending so the unparsed-parent sweeper can still recover emails.
   */
  markProcessingException: boolean;
}

export interface ForensicImportTarget {
  kind: 'forensic-import';
  tenantId: string;
  importId: string;
}

export interface PstExtractTarget {
  kind: 'pst-extract';
  tenantId: string;
  collectionId: string;
  custodianId: string;
  evidenceItemId: string;
}

export type FailureTarget =
  CollectionItemTarget | EvidenceItemTarget | ForensicImportTarget | PstExtractTarget;

function str(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * What this queue's payload lets us mark, or null when there is nothing to mark.
 *
 * Returns null rather than guessing on an unexpected payload: writing `failed`
 * against the wrong row is worse than leaving the sweeper to complain.
 */
export function failureTargetFor(
  queue: QueueName | string,
  payload: unknown,
): FailureTarget | null {
  if (payload === null || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const tenantId = str(data, 'tenantId');
  if (tenantId === null) return null;

  if (queue === QUEUES.collectionFetchItem) {
    const collectionId = str(data, 'collectionId');
    const custodianId = str(data, 'custodianId');
    const source = str(data, 'source');
    const providerItemId = str(data, 'providerItemId');
    if (collectionId === null || custodianId === null || providerItemId === null) return null;
    if (source !== 'email' && source !== 'drive' && source !== 'audit') return null;
    return { kind: 'collection-item', tenantId, collectionId, custodianId, source, providerItemId };
  }

  // Pipeline stages after preservation carry the evidence item, not the
  // provider item. A death here leaves the item preserved but not parsed or
  // indexed, which is the other half of what staging showed.
  if (queue === QUEUES.processParse || queue === QUEUES.processExtract) {
    const evidenceItemId = str(data, 'evidenceItemId');
    if (evidenceItemId === null) return null;
    return {
      kind: 'evidence-item',
      tenantId,
      evidenceItemId,
      markProcessingException: queue === QUEUES.processExtract,
    };
  }

  if (queue === QUEUES.importAnalyze) {
    const importId = str(data, 'importId');
    if (importId === null) return null;
    return { kind: 'forensic-import', tenantId, importId };
  }

  if (queue === QUEUES.pstExtract) {
    const collectionId = str(data, 'collectionId');
    const custodianId = str(data, 'custodianId');
    const evidenceItemId = str(data, 'evidenceItemId');
    if (collectionId === null || custodianId === null || evidenceItemId === null) return null;
    return { kind: 'pst-extract', tenantId, collectionId, custodianId, evidenceItemId };
  }

  return null;
}

/** The states a job failure must not overwrite. */
const TERMINAL_STATES = ['failed', 'skipped', 'indexed'] as const;

/**
 * Write the failure the processor could not.
 *
 * Only touches a row that is still mid-flight. If the processor's own catch
 * already recorded the failure, this does nothing — the ledger must not count
 * the same failure twice.
 */
export async function recordTerminalFailure(
  ctx: WorkerContext,
  target: FailureTarget,
  reason: string,
): Promise<void> {
  const message = `job did not finish: ${reason}`.slice(0, 1000);

  if (target.kind === 'forensic-import') {
    await withTenantContext(ctx.prisma, target.tenantId, (tx) =>
      tx.forensicImport.updateMany({
        where: {
          id: target.importId,
          tenantId: target.tenantId,
          status: { not: 'completed' },
        },
        data: { status: 'failed', error: message },
      }),
    );
    ctx.log.warn(
      { importId: target.importId, reason },
      'recorded a terminal import failure the processor never saw',
    );
    return;
  }

  if (target.kind === 'pst-extract') {
    const providerItemId = `pst:${target.evidenceItemId}`;
    await withTenantContext(ctx.prisma, target.tenantId, async (tx) => {
      const item = await tx.collectionItem.findFirst({
        where: {
          tenantId: target.tenantId,
          collectionId: target.collectionId,
          custodianId: target.custodianId,
          source: 'email',
          providerItemId,
          state: { notIn: [...TERMINAL_STATES] },
        },
        select: { id: true },
      });
      if (item !== null) {
        await tx.collectionItem.update({
          where: { id: item.id },
          data: { state: 'failed', lastError: message },
        });
        await recordException(tx, {
          tenantId: target.tenantId,
          collectionId: target.collectionId,
          custodianId: target.custodianId,
          source: 'email',
          providerItemId,
          kind: 'api_error',
          message,
          detail: { recoveredBy: 'job-failure-handler' },
        });
        await incrementProgress(tx, target.collectionId, target.custodianId, 'email', {
          failures: 1,
        });
      }
      await tx.evidenceItem.updateMany({
        where: {
          id: target.evidenceItemId,
          processingStatus: 'pending',
        },
        data: { processingStatus: 'exception', processingDetail: message.slice(0, 500) },
      });
    });
    ctx.log.warn(
      {
        collectionId: target.collectionId,
        evidenceItemId: target.evidenceItemId,
        reason,
      },
      'recorded a terminal pst.extract failure the processor never saw',
    );
    return;
  }

  if (target.kind === 'evidence-item') {
    await withTenantContext(ctx.prisma, target.tenantId, async (tx) => {
      await tx.collectionItem.updateMany({
        where: {
          tenantId: target.tenantId,
          evidenceItemId: target.evidenceItemId,
          state: { notIn: [...TERMINAL_STATES] },
        },
        data: { state: 'failed', lastError: message },
      });
      if (!target.markProcessingException) return;

      const item = await tx.evidenceItem.findFirst({
        where: { id: target.evidenceItemId, tenantId: target.tenantId },
        select: {
          id: true,
          collectionId: true,
          custodianId: true,
          providerItemId: true,
          name: true,
          mimeType: true,
          size: true,
        },
      });
      // Only overwrite pending. If extract already wrote text, a later stall
      // of a duplicate job must not hide a file that did complete.
      await tx.evidenceItem.updateMany({
        where: {
          id: target.evidenceItemId,
          tenantId: target.tenantId,
          processingStatus: 'pending',
        },
        data: { processingStatus: 'exception', processingDetail: message.slice(0, 500) },
      });
      // Attachments often have no collection_items row. Without a ledger
      // entry the exceptions list stays empty, Retry looks like it has
      // nothing to do, and the missing text is invisible.
      if (item !== null && item.collectionId !== null) {
        await recordException(tx, {
          tenantId: target.tenantId,
          collectionId: item.collectionId,
          custodianId: item.custodianId ?? undefined,
          providerItemId: item.providerItemId,
          kind: 'api_error',
          message,
          detail: {
            recoveredBy: 'job-failure-handler',
            evidenceItemId: item.id,
            name: item.name,
            mimeType: item.mimeType,
            sizeBytes: Number(item.size),
          },
        });
      }
    });
    ctx.log.warn(
      { evidenceItemId: target.evidenceItemId, reason },
      'recorded a terminal failure the processor never saw',
    );
    return;
  }

  await withTenantContext(ctx.prisma, target.tenantId, async (tx) => {
    const item = await tx.collectionItem.findFirst({
      where: {
        tenantId: target.tenantId,
        collectionId: target.collectionId,
        custodianId: target.custodianId,
        source: target.source,
        providerItemId: target.providerItemId,
        state: { notIn: [...TERMINAL_STATES] },
      },
      select: { id: true },
    });
    // Already terminal: the processor got there first, or a retry succeeded.
    if (item === null) return;

    await tx.collectionItem.update({
      where: { id: item.id },
      data: { state: 'failed', lastError: message },
    });
    await recordException(tx, {
      tenantId: target.tenantId,
      collectionId: target.collectionId,
      custodianId: target.custodianId,
      source: target.source,
      providerItemId: target.providerItemId,
      kind: 'api_error',
      message,
      detail: { recoveredBy: 'job-failure-handler' },
    });
    await incrementProgress(tx, target.collectionId, target.custodianId, target.source, {
      failures: 1,
    });
  });

  ctx.log.warn(
    {
      collectionId: target.collectionId,
      providerItemId: target.providerItemId,
      reason,
    },
    'recorded a terminal failure the processor never saw',
  );
}
