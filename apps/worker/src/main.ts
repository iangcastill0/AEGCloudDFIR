import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient } from '@aeg-clouddfir/database';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { BullMqEnqueuer } from './bullmq-enqueuer.js';
import { buildWorkerContext } from './context.js';
import { FinalizeSweeper } from './finalize-sweeper.js';
import { StalledItemSweeper } from './stalled-item-sweeper.js';
import { startHealthServer } from './health.js';
import { WorkerMetrics } from './metrics.js';
import { closeImapPools } from './connector-factory.js';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { createWorkers } from './workers.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.CDFIR_LOG_LEVEL,
    redact: { paths: ['token', 'secret', 'authorization', 'cookie', 'presignedUrl'], remove: true },
  });
  log.info({ config: 'validated' }, 'worker starting');
  if (config.CDFIR_DEMO_MODE) {
    log.warn({}, 'DEMO SEED MODE is active — never enable in production');
  }

  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const redis = new Redis(config.CDFIR_REDIS_URL, { maxRetriesPerRequest: null });
  const enqueuer = new BullMqEnqueuer(redis);
  const dispatcher = new OutboxDispatcher(prisma, enqueuer, log);
  const ctx = buildWorkerContext(config, { prisma, redis, log, enqueuer });

  // Create the search index with its explicit mapping BEFORE anything indexes.
  // Without this, the first bulk write auto-creates a concrete index under the
  // alias name using OpenSearch's dynamic mapping, which types every id field as
  // `text`. Sorting or aggregating on a text field then fails at query time with
  // "Text fields are not optimised for operations that require per-document
  // field data" — so indexing appears to succeed and every search 400s.
  // Non-fatal: a worker that cannot reach OpenSearch should still process and
  // persist evidence, and indexing retries independently.
  try {
    const { created, indexName } = await ctx.search.ensureIndex();
    log.info({ indexName, created }, created ? 'search index created' : 'search index present');
  } catch (err) {
    log.error({ err }, 'could not ensure the search index; searches may fail until it exists');
  }

  const workers = createWorkers(ctx, redis);
  log.info({ workerCount: workers.length }, 'queue workers started');

  const metrics = new WorkerMetrics();
  const metricsServer = metrics.serve(config.CDFIR_METRICS_PORT);
  const outboxSampler = setInterval(() => {
    void prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.worker', 'true', true)`;
        return tx.outboxEvent.count({ where: { status: 'pending' } });
      })
      .then((n) => metrics.outboxPending.set(n))
      .catch(() => undefined);
  }, 15_000);
  outboxSampler.unref();

  const abort = new AbortController();
  // Self-healing finalization: recovers collections whose last settling stage
  // did not emit a finalize check (finalize is idempotent and re-gates).
  const sweeper = new FinalizeSweeper(prisma, log);
  void sweeper.run(abort.signal);

  // Finalize asks whether a collection is done. This moves the items that
  // stopped answering, so the question can eventually be answered yes.
  const stalledItems = new StalledItemSweeper(prisma, log);
  void stalledItems.run(abort.signal);
  const health = startHealthServer(config.CDFIR_WORKER_HEALTH_PORT, {
    ready: async () => {
      const checks: Record<string, boolean> = {};
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = true;
      } catch {
        checks.postgres = false;
      }
      checks.redis = redis.status === 'ready';
      checks.dispatcher = dispatcher.isRunning;
      return checks;
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    abort.abort();
    clearInterval(outboxSampler);
    metricsServer.close();
    health.close();
    // Close queue workers BEFORE the connections they depend on.
    await Promise.all(workers.map((w) => w.close())).catch(() => undefined);
    // Pooled IMAP logins are held for the life of the process; a provider counts
    // an abandoned connection against the account's limit until it times out.
    await closeImapPools().catch(() => undefined);
    await enqueuer.close();
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await dispatcher.run(abort.signal);
}

main().catch((err) => {
  // ConfigValidationError messages already elide secret values.
  console.error('worker fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
