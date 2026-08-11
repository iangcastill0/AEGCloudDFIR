import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { sanitizeError, type WorkerContext } from './context.js';
import { withJobAttempt } from './job-attempts.js';
import { processCollectionDiscover } from './processors/collection-discover.js';
import { processCollectionFetchItem } from './processors/collection-fetch-item.js';
import { processCollectionFetchPage } from './processors/collection-fetch-page.js';
import { processCollectionFinalize } from './processors/collection-finalize.js';
import { processExportRun } from './processors/export-run.js';
import { processExtract } from './processors/process-extract.js';
import { processOcr } from './processors/process-ocr.js';
import { processParse } from './processors/process-parse.js';
import { processScan } from './processors/process-scan.js';
import { processProductionRun } from './processors/production-run.js';
import { deletionRun, deletionRunPayload } from './processors/deletion-run.js';
import { processSearchIndex } from './processors/search-index.js';
import {
  discoverPayload,
  evidenceStagePayload,
  exportRunPayload,
  fetchItemPayload,
  fetchPagePayload,
  finalizePayload,
  productionRunPayload,
  tenantOnlyPayload,
} from './processors/payloads.js';
import { BACKOFF_STRATEGIES, DEFAULT_JOB_OPTIONS, QUEUES, type QueueName } from './queues.js';

/** Per-queue concurrency: IO-heavy stages fan out; run-level stages serialize. */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUES.collectionDiscover]: 2,
  [QUEUES.collectionFetchPage]: 2,
  [QUEUES.collectionFetchItem]: 8,
  [QUEUES.collectionFinalize]: 2,
  [QUEUES.processParse]: 4,
  [QUEUES.processExtract]: 4,
  [QUEUES.processOcr]: 4,
  [QUEUES.processPreview]: 4,
  [QUEUES.processScan]: 4,
  [QUEUES.searchIndex]: 8,
  [QUEUES.exportRun]: 1,
  [QUEUES.productionRun]: 1,
  [QUEUES.deletionRun]: 1,
  [QUEUES.deadLetter]: 2,
};

type QueueHandler = (ctx: WorkerContext, data: unknown) => Promise<void>;

/** Queue -> payload-validated processor. */
export function buildHandlers(): Record<QueueName, QueueHandler> {
  return {
    [QUEUES.collectionDiscover]: (ctx, data) =>
      processCollectionDiscover(ctx, discoverPayload.parse(data)),
    [QUEUES.collectionFetchPage]: (ctx, data) =>
      processCollectionFetchPage(ctx, fetchPagePayload.parse(data)),
    [QUEUES.collectionFetchItem]: (ctx, data) =>
      processCollectionFetchItem(ctx, fetchItemPayload.parse(data)),
    [QUEUES.collectionFinalize]: (ctx, data) =>
      processCollectionFinalize(ctx, finalizePayload.parse(data)),
    [QUEUES.processParse]: (ctx, data) => processParse(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processExtract]: (ctx, data) => processExtract(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processOcr]: (ctx, data) => processOcr(ctx, evidenceStagePayload.parse(data)),
    // Previews are generated inside process.parse today; the queue stays a
    // no-op consumer so enqueued jobs drain instead of rotting.
    [QUEUES.processPreview]: (ctx, data) => {
      evidenceStagePayload.parse(data);
      void ctx;
      return Promise.resolve();
    },
    [QUEUES.processScan]: (ctx, data) => processScan(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.searchIndex]: (ctx, data) => processSearchIndex(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.exportRun]: (ctx, data) => processExportRun(ctx, exportRunPayload.parse(data)),
    [QUEUES.productionRun]: (ctx, data) =>
      processProductionRun(ctx, productionRunPayload.parse(data)),
    [QUEUES.deletionRun]: (ctx, data) => deletionRun(ctx, deletionRunPayload.parse(data)),
    [QUEUES.deadLetter]: (ctx, data) => {
      const parsed = tenantOnlyPayload.parse(data);
      ctx.log.error(
        { tenantId: parsed.tenantId, payload: data },
        'dead-letter: job requires operator attention',
      );
      return Promise.resolve();
    },
  };
}

/**
 * Create one BullMQ Worker per queue. Exhausted jobs (final failed attempt)
 * are copied to the dead-letter queue for operator triage.
 */
export function createWorkers(ctx: WorkerContext, connection: Redis): Worker[] {
  const handlers = buildHandlers();
  const workers: Worker[] = [];
  const maxAttempts = DEFAULT_JOB_OPTIONS.attempts ?? 8;

  for (const [queueName, handler] of Object.entries(handlers) as [QueueName, QueueHandler][]) {
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        await withJobAttempt(ctx, queueName, job, () => handler(ctx, job.data));
      },
      {
        connection,
        concurrency: QUEUE_CONCURRENCY[queueName],
        settings: {
          backoffStrategy: (attemptsMade: number) => BACKOFF_STRATEGIES['ev-jitter'](attemptsMade),
        },
      },
    );

    worker.on('failed', (job, err) => {
      const attempts = job?.opts.attempts ?? maxAttempts;
      ctx.log.warn(
        {
          queue: queueName,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
          err: sanitizeError(err),
        },
        'job attempt failed',
      );
      if (queueName === QUEUES.deadLetter) return;
      if (job !== undefined && job.attemptsMade >= attempts) {
        void ctx.enqueuer
          .enqueue(QUEUES.deadLetter, `dl:${queueName}:${job.id ?? 'unknown'}`, {
            tenantId: (job.data as { tenantId?: string }).tenantId,
            queue: queueName,
            jobId: job.id,
            failedReason: sanitizeError(err),
            payload: job.data,
          })
          .catch((enqueueErr: unknown) => {
            ctx.log.error(
              { queue: queueName, jobId: job.id, err: sanitizeError(enqueueErr) },
              'failed to move exhausted job to dead-letter',
            );
          });
      }
    });
    worker.on('error', (err) => {
      ctx.log.error({ queue: queueName, err: sanitizeError(err) }, 'worker error');
    });

    workers.push(worker);
  }
  return workers;
}
