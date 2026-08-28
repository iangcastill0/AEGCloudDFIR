import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { DispatcherLogger } from './outbox/dispatcher.js';
import { QUEUES, dedupKeys } from './queues.js';
import {
  MAX_RECOVERY_ATTEMPTS,
  STALL_AFTER_MS,
  recoveryPlan,
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
