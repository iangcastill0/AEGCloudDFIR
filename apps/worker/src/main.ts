import { loadConfig } from '@evidencevault/config';
import { createPrismaClient } from '@evidencevault/database';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { BullMqEnqueuer } from './bullmq-enqueuer.js';
import { buildWorkerContext } from './context.js';
import { startHealthServer } from './health.js';
import { WorkerMetrics } from './metrics.js';
import { OutboxDispatcher } from './outbox/dispatcher.js';
import { createWorkers } from './workers.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.EV_LOG_LEVEL,
    redact: { paths: ['token', 'secret', 'authorization', 'cookie', 'presignedUrl'], remove: true },
  });
  log.info({ config: 'validated' }, 'worker starting');
  if (config.EV_DEMO_MODE) {
    log.warn({}, 'DEMO SEED MODE is active — never enable in production');
  }

  const prisma = createPrismaClient(config.EV_DATABASE_URL);
  const redis = new Redis(config.EV_REDIS_URL, { maxRetriesPerRequest: null });
  const enqueuer = new BullMqEnqueuer(redis);
  const dispatcher = new OutboxDispatcher(prisma, enqueuer, log);
  const ctx = buildWorkerContext(config, { prisma, redis, log, enqueuer });
  const workers = createWorkers(ctx, redis);
  log.info({ workerCount: workers.length }, 'queue workers started');

  const metrics = new WorkerMetrics();
  const metricsServer = metrics.serve(config.EV_METRICS_PORT);
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
  const health = startHealthServer(config.EV_WORKER_HEALTH_PORT, {
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
