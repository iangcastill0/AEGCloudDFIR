import { ZodError } from 'zod';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
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
import { processPreview } from './processors/process-preview.js';
import { processScan } from './processors/process-scan.js';
import { processPstExtract } from './processors/pst-extract.js';
import { processProductionRun } from './processors/production-run.js';
import { deletionRun, deletionRunPayload } from './processors/deletion-run.js';
import { processSearchCaseCollection } from './processors/search-case-collection.js';
import { processSearchIndex } from './processors/search-index.js';
import {
  caseCollectionPayload,
  discoverPayload,
  evidenceStagePayload,
  exportRunPayload,
  fetchItemPayload,
  fetchPagePayload,
  finalizePayload,
  productionRunPayload,
  pstExtractPayload,
  tenantOnlyPayload,
} from './processors/payloads.js';
import { BACKOFF_STRATEGIES, DEFAULT_JOB_OPTIONS, QUEUES, type QueueName } from './queues.js';
import { failureTargetFor, isTerminalFailure, recordTerminalFailure } from './terminal-failure.js';
import { classifyProviderError } from './permanent-errors.js';

/**
 * Per-queue concurrency: CPU-heavy stages scale with the machine, provider and
 * run-level stages do not.
 *
 * `cpuConcurrency` comes from CDFIR_WORKER_CPU_CONCURRENCY and applies ONLY to
 * the four stages that burn CPU locally — parse, extract, OCR, preview. Those
 * were fixed at 4, which meant a bigger machine bought nothing: on a five-core
 * host, load sat at 27 with 218,746 extractions and 26,957 OCR jobs queued, and
 * a 32-core host would have run exactly the same four at a time.
 *
 * Everything else is deliberately left alone, and the reasons differ:
 *
 * - Provider fetches are limited by Microsoft and Google rate limits, not by
 *   this machine. Raising them buys 429s, not throughput.
 * - pstExtract holds a temp copy of a whole container on disk, so one at a time
 *   is a memory and disk decision.
 * - Run-level stages (export, production, deletion) must serialize to produce
 *   one coherent artifact.
 * - processScan is bounded by ClamAV's own thread pool, not by cores here;
 *   raising it past clamd's MaxThreads just queues inside clamd instead.
 */
export function queueConcurrency(cpuConcurrency: number): Record<QueueName, number> {
  return {
    [QUEUES.collectionDiscover]: 2,
    [QUEUES.collectionFetchPage]: 2,
    [QUEUES.collectionFetchItem]: 8,
    [QUEUES.collectionFinalize]: 2,
    // Container extraction is memory/disk heavy (temp copy of the whole PST).
    [QUEUES.pstExtract]: 1,
    [QUEUES.processParse]: cpuConcurrency,
    [QUEUES.processExtract]: cpuConcurrency,
    [QUEUES.processOcr]: cpuConcurrency,
    [QUEUES.processPreview]: cpuConcurrency,
    [QUEUES.processScan]: 4,
    [QUEUES.searchIndex]: 8,
    // One long engine-side request per job, not something to fan out. Two so a
    // second case add is not stuck behind a large one.
    [QUEUES.searchCaseCollection]: 2,
    [QUEUES.exportRun]: 1,
    [QUEUES.productionRun]: 1,
    [QUEUES.deletionRun]: 1,
    [QUEUES.deadLetter]: 2,
  };
}

/** The stages CDFIR_WORKER_CPU_CONCURRENCY governs. */
export const CPU_BOUND_QUEUES: readonly QueueName[] = [
  QUEUES.processParse,
  QUEUES.processExtract,
  QUEUES.processOcr,
  QUEUES.processPreview,
];

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
    [QUEUES.pstExtract]: (ctx, data) => processPstExtract(ctx, pstExtractPayload.parse(data)),
    [QUEUES.processParse]: (ctx, data) => processParse(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processExtract]: (ctx, data) => processExtract(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processOcr]: (ctx, data) => processOcr(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processPreview]: (ctx, data) => processPreview(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.processScan]: (ctx, data) => processScan(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.searchIndex]: (ctx, data) => processSearchIndex(ctx, evidenceStagePayload.parse(data)),
    [QUEUES.searchCaseCollection]: (ctx, data) =>
      processSearchCaseCollection(ctx, caseCollectionPayload.parse(data)),
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
  const concurrency = queueConcurrency(ctx.config.CDFIR_WORKER_CPU_CONCURRENCY);
  const handlers = buildHandlers();
  const workers: Worker[] = [];
  const maxAttempts = DEFAULT_JOB_OPTIONS.attempts ?? 8;

  for (const [queueName, handler] of Object.entries(handlers) as [QueueName, QueueHandler][]) {
    const worker = new Worker(
      queueName,
      async (job: Job) => {
        // A payload that fails validation will fail identically on every
        // attempt: the stored row does not change between them. Observed on a
        // real Slack collection — every item retried EIGHT times on the same
        // Zod error before dead-lettering, which is minutes of pure waste on a
        // 2,000-message run and buries the transient failures retries exist for.
        await withJobAttempt(ctx, queueName, job, async () => {
          try {
            await handler(ctx, job.data);
          } catch (err) {
            if (err instanceof ZodError) {
              throw new UnrecoverableError(`invalid ${queueName} payload: ${err.message}`);
            }
            // Same principle, different source: some provider answers cannot
            // change between attempts either. A customer disabling our app in
            // their tenant produced 6,720 identical token failures in five
            // minutes, all of them waiting on a person in another company.
            const verdict = classifyProviderError(err);
            if (verdict.permanent) {
              throw new UnrecoverableError(
                `${verdict.reason}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            throw err;
          }
        });
      },
      {
        connection,
        concurrency: concurrency[queueName],
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            BACKOFF_STRATEGIES['cdfir-jitter'](attemptsMade),
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
      if (job === undefined) return;

      // A STALLED job never reached the processor's catch — the worker was
      // killed mid-execution, so nothing marked its row. Without this, the item
      // sits in `fetching` forever, the collection cannot finalize, and the page
      // reports zero failures. That is exactly what a deploy did on staging.
      const reason = sanitizeError(err);
      if (isTerminalFailure({ reason, attemptsMade: job.attemptsMade, attempts })) {
        const target = failureTargetFor(queueName, job.data);
        if (target !== null) {
          void recordTerminalFailure(ctx, target, reason).catch((writeErr: unknown) => {
            ctx.log.error(
              { queue: queueName, jobId: job.id, err: sanitizeError(writeErr) },
              'could not record a terminal job failure',
            );
          });
        }
      }

      if (job.attemptsMade >= attempts) {
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
