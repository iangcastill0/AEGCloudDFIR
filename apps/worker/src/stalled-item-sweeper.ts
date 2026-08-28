import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { DispatcherLogger } from './outbox/dispatcher.js';
import { QUEUES, dedupKeys } from './queues.js';
import {
  MAX_RECOVERY_ATTEMPTS,
  STALL_AFTER_MS,
  pageWalkPlan,
  recoveryPlan,
  unparsedParentPlan,
  type ItemState,
} from './stalled-items.js';

/**
 * Re-drives collection items that stopped moving, so a collection can always
 * reach an end state.
 *
 * The FinalizeSweeper already re-asks "is this collection done?" every 30
 * seconds. That is not enough on its own: finalize waits for every item to
 * settle, and a worker killed by a deploy or an outage leaves items holding an
 * in-flight state with no job behind them. Asking again cannot help, so the
 * collection waits forever while the nudges pile up — 6,248 of them over eight
 * days, in the case that prompted this.
 *
 * This sweeper fixes the items themselves. Bounded retries, then an honest
 * recorded failure, which is what lets finalize finish.
 *
 * Deliberately mirrors FinalizeSweeper's tenant iteration rather than reading
 * across tenants: the worker's platform context has no policy on
 * evidence-bearing tables, and recovering a stuck job is not a reason to widen
 * that.
 */
export class StalledItemSweeper {
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: DispatcherLogger,
    /** Longer than the finalize sweep: recovery is repair, not a hot path. */
    private readonly intervalMs = 120_000,
    /** Cap per tenant per pass, so one broken collection cannot starve others. */
    private readonly batchSize = 200,
  ) {}

  async sweepOnce(): Promise<{ requeued: number; gaveUp: number }> {
    const tenants = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      return tx.tenant.findMany({ select: { id: true } });
    });

    let requeued = 0;
    let gaveUp = 0;

    for (const tenant of tenants) {
      try {
        const result = await withTenantContext(this.prisma, tenant.id, async (tx) => {
          const now = new Date();
          const items = await tx.collectionItem.findMany({
            where: {
              state: { in: ['discovered', 'fetching', 'preserved'] },
              updatedAt: { lt: new Date(now.getTime() - STALL_AFTER_MS) },
              collection: { status: { in: ['fetching', 'cancelling', 'finalizing'] } },
            },
            select: {
              id: true,
              collectionId: true,
              custodianId: true,
              source: true,
              providerItemId: true,
              state: true,
              attempts: true,
              updatedAt: true,
              evidenceItemId: true,
            },
            take: this.batchSize,
          });

          let localRequeued = 0;
          let localGaveUp = 0;
          const touchedCollections = new Set<string>();

          for (const item of items) {
            const plan = recoveryPlan({
              state: item.state as ItemState,
              source: item.source,
              attempts: item.attempts,
              updatedAt: item.updatedAt,
              evidenceItemId: item.evidenceItemId,
              now,
            });
            if (plan.kind === 'wait') continue;
            touchedCollections.add(item.collectionId);

            if (plan.kind === 'give-up') {
              await tx.collectionItem.update({
                where: { id: item.id },
                data: { state: 'failed', lastError: plan.reason },
              });
              // An exception row is the part a reviewer sees. A collection that
              // closes with unexplained gaps is worse than one that never closed.
              await tx.collectionException.create({
                data: {
                  tenantId: tenant.id,
                  collectionId: item.collectionId,
                  custodianId: item.custodianId,
                  source: item.source,
                  providerItemId: item.providerItemId,
                  kind: 'api_error',
                  message: plan.reason,
                  detail: {
                    recoveredBy: 'stalled-item-sweeper',
                    lastState: item.state,
                    attempts: item.attempts,
                  },
                },
              });
              localGaveUp += 1;
              continue;
            }

            // A fresh attempt number makes a fresh dedup key. Dispatched rows
            // are kept and (topic, dedupKey) is unique, so a repeated key is
            // silently dropped and the item would never move.
            const attempt = item.attempts + 1;
            const dedupKey =
              plan.stage === 'fetch'
                ? `${dedupKeys.collectionFetchItem(item.collectionId, item.custodianId, item.source, item.providerItemId)}:a${String(attempt)}`
                : dedupKeys.searchIndex(
                    item.evidenceItemId ?? item.id,
                    1,
                    `recover${String(attempt)}`,
                  );

            await tx.collectionItem.update({
              where: { id: item.id },
              data: { attempts: attempt },
            });
            await tx.outboxEvent.createMany({
              data: [
                {
                  tenantId: tenant.id,
                  topic: plan.topic,
                  dedupKey,
                  payload:
                    plan.stage === 'fetch'
                      ? {
                          tenantId: tenant.id,
                          collectionId: item.collectionId,
                          custodianId: item.custodianId,
                          source: item.source,
                          providerItemId: item.providerItemId,
                        }
                      : {
                          tenantId: tenant.id,
                          evidenceItemId: item.evidenceItemId,
                          version: 1,
                        },
                },
              ],
              skipDuplicates: true,
            });
            localRequeued += 1;
          }

          // --- page checkpoints ---------------------------------------------
          // A checkpoint means "there is more in this scope that was never
          // fetched". Finalize gates on it, and recovering only items left a
          // collection stuck for 8h20m with five frozen folders.
          const checkpoints = await tx.collectionCheckpoint.findMany({
            where: {
              cursorKind: 'page',
              updatedAt: { lt: new Date(now.getTime() - STALL_AFTER_MS) },
              collection: { status: { in: ['fetching', 'cancelling', 'finalizing'] } },
            },
            select: {
              id: true,
              collectionId: true,
              custodianId: true,
              source: true,
              scopeKey: true,
              updatedAt: true,
            },
            take: this.batchSize,
          });

          for (const cp of checkpoints) {
            // Attempts come from the outbox, not a column: dispatched rows are
            // kept, so the recovery keys already written ARE the attempt count.
            // No migration, and it survives a worker restart.
            const prefix = `${dedupKeys.collectionFetchPage(cp.collectionId, cp.custodianId, cp.source, cp.scopeKey, '')}`;
            const priorAttempts = await tx.outboxEvent.count({
              where: {
                topic: QUEUES.collectionFetchPage,
                dedupKey: { startsWith: prefix, contains: 'recover' },
              },
            });
            const plan = pageWalkPlan({
              idleMs: now.getTime() - cp.updatedAt.getTime(),
              priorAttempts,
            });
            if (plan.kind === 'wait') continue;
            touchedCollections.add(cp.collectionId);

            if (plan.kind === 'give-up') {
              // Removing the checkpoint unblocks finalize. It also means mail
              // was left uncollected, so the exception is not optional — it is
              // the only place that fact survives.
              await tx.collectionException.create({
                data: {
                  tenantId: tenant.id,
                  collectionId: cp.collectionId,
                  custodianId: cp.custodianId,
                  source: cp.source,
                  providerItemId: cp.scopeKey,
                  kind: 'expired_checkpoint',
                  message: plan.reason,
                  detail: { recoveredBy: 'stalled-item-sweeper', scopeKey: cp.scopeKey },
                },
              });
              await tx.collectionCheckpoint.delete({ where: { id: cp.id } });
              localGaveUp += 1;
              continue;
            }

            await tx.outboxEvent.createMany({
              data: [
                {
                  tenantId: tenant.id,
                  topic: QUEUES.collectionFetchPage,
                  dedupKey: `${prefix}recover${String(priorAttempts + 1)}`,
                  payload: {
                    tenantId: tenant.id,
                    collectionId: cp.collectionId,
                    custodianId: cp.custodianId,
                    source: cp.source,
                    scopeKey: cp.scopeKey,
                  },
                },
              ],
              skipDuplicates: true,
            });
            localRequeued += 1;
          }

          // --- parents still awaiting parse ---------------------------------
          // Parse creates attachment children, so finalize gates on this
          // directly: sealing the manifest first would omit them.
          const activeCollections = await tx.collection.findMany({
            where: { status: { in: ['fetching', 'cancelling', 'finalizing'] } },
            select: { id: true },
            take: 500,
          });
          const activeIds = activeCollections.map((c) => c.id);
          if (activeIds.length > 0) {
            const parents = await tx.evidenceItem.findMany({
              where: {
                collectionId: { in: activeIds },
                processingStatus: 'pending',
                kind: { in: ['email', 'container'] },
                updatedAt: { lt: new Date(now.getTime() - STALL_AFTER_MS) },
              },
              select: { id: true, collectionId: true, updatedAt: true, version: true },
              take: this.batchSize,
            });

            for (const parent of parents) {
              const parsePrefix = `${dedupKeys.processStage('parse', parent.id, parent.version)}:`;
              const priorAttempts = await tx.outboxEvent.count({
                where: {
                  topic: QUEUES.processParse,
                  dedupKey: { startsWith: parsePrefix, contains: 'recover' },
                },
              });
              const plan = unparsedParentPlan({
                idleMs: now.getTime() - parent.updatedAt.getTime(),
                priorAttempts,
              });
              if (plan.kind === 'wait') continue;
              if (parent.collectionId !== null) touchedCollections.add(parent.collectionId);

              if (plan.kind === 'give-up') {
                await tx.evidenceItem.update({
                  where: { id: parent.id },
                  data: { processingStatus: 'exception' },
                });
                if (parent.collectionId !== null) {
                  await tx.collectionException.create({
                    data: {
                      tenantId: tenant.id,
                      collectionId: parent.collectionId,
                      kind: 'corrupt_item',
                      message: plan.reason,
                      detail: {
                        recoveredBy: 'stalled-item-sweeper',
                        evidenceItemId: parent.id,
                      },
                    },
                  });
                }
                localGaveUp += 1;
                continue;
              }

              await tx.outboxEvent.createMany({
                data: [
                  {
                    tenantId: tenant.id,
                    topic: QUEUES.processParse,
                    dedupKey: `${parsePrefix}recover${String(priorAttempts + 1)}`,
                    payload: {
                      tenantId: tenant.id,
                      evidenceItemId: parent.id,
                      version: parent.version,
                    },
                  },
                ],
                skipDuplicates: true,
              });
              localRequeued += 1;
            }
          }

          // Giving up on the last blocker is exactly when finalize should look
          // again, rather than waiting out the next finalize sweep.
          for (const collectionId of touchedCollections) {
            await tx.outboxEvent.createMany({
              data: [
                {
                  tenantId: tenant.id,
                  topic: QUEUES.collectionFinalize,
                  dedupKey: `${dedupKeys.collectionFinalize(collectionId)}:recovered:${String(Date.now())}`,
                  payload: { tenantId: tenant.id, collectionId },
                },
              ],
              skipDuplicates: true,
            });
          }

          return { localRequeued, localGaveUp };
        });

        requeued += result.localRequeued;
        gaveUp += result.localGaveUp;
      } catch (err) {
        this.log.warn(
          { tenantId: tenant.id, err: err instanceof Error ? err.message : String(err) },
          'stalled item sweep: tenant pass failed',
        );
      }
    }

    if (requeued > 0 || gaveUp > 0) {
      this.log.warn(
        { requeued, gaveUp, maxAttempts: MAX_RECOVERY_ATTEMPTS },
        'stalled item sweep recovered items left behind by an interrupted run',
      );
    }
    return { requeued, gaveUp };
  }

  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    while (!signal.aborted) {
      try {
        await this.sweepOnce();
      } catch (err) {
        this.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'stalled item sweep failed',
        );
      }
      await sleep(this.intervalMs, signal);
    }
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
