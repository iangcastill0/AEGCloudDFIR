import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { DispatcherLogger } from './outbox/dispatcher.js';
import { QUEUES, dedupKeys } from './queues.js';

/**
 * Periodically nudges collections that are still 'fetching'/'cancelling' so
 * finalization can never be stranded by a missed enqueue.
 *
 * Finalize checks are normally emitted by the stage that settles the last item.
 * Relying on that alone is fragile: any terminal path that forgets to nudge
 * (observed with an extract-exception path) leaves a collection stuck in
 * 'fetching' forever with all work complete. This sweeper makes finalization
 * self-healing — the finalize processor is idempotent and re-checks its own
 * gate, so an extra nudge is always safe and a missing one is always recovered.
 */
export class FinalizeSweeper {
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: DispatcherLogger,
    private readonly intervalMs = 30_000,
  ) {}

  /**
   * Enqueue a finalize check for every collection that may still need one.
   *
   * Deliberately iterates tenants and uses tenant context rather than reading
   * `collections` cross-tenant: row-level security gives the worker context no
   * policy on evidence-bearing tables (fail closed), and this sweep is not a
   * reason to widen that.
   */
  async sweepOnce(): Promise<number> {
    const tenants = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      return tx.tenant.findMany({ select: { id: true } });
    });

    let nudged = 0;
    for (const tenant of tenants) {
      try {
        const stuck = await withTenantContext(this.prisma, tenant.id, async (tx) => {
          const rows = await tx.collection.findMany({
            where: {
              status: { in: ['fetching', 'cancelling', 'finalizing'] },
              updatedAt: { lt: new Date(Date.now() - 20_000) },
            },
            select: { id: true },
            take: 200,
          });
          for (const row of rows) {
            await tx.outboxEvent.createMany({
              data: [
                {
                  tenantId: tenant.id,
                  topic: QUEUES.collectionFinalize,
                  dedupKey: `${dedupKeys.collectionFinalize(row.id)}:sweep:${Date.now()}`,
                  payload: { tenantId: tenant.id, collectionId: row.id },
                },
              ],
              skipDuplicates: true,
            });
          }
          return rows.length;
        });
        nudged += stuck;
      } catch (err) {
        this.log.warn(
          { tenantId: tenant.id, err: err instanceof Error ? err.message : String(err) },
          'finalize sweep: tenant pass failed',
        );
      }
    }
    if (nudged > 0) this.log.info({ collections: nudged }, 'finalize sweep enqueued checks');
    return nudged;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    while (!signal.aborted) {
      try {
        await this.sweepOnce();
      } catch (err) {
        this.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'finalize sweep failed',
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
