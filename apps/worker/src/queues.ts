import type { JobsOptions } from 'bullmq';

/**
 * Queue topology. Outbox topics map 1:1 to queue names; job dedup keys become
 * BullMQ jobIds so redelivery of the same logical work is collapsed.
 */
export const QUEUES = {
  collectionDiscover: 'collection.discover',
  collectionFetchPage: 'collection.fetch-page',
  collectionFetchItem: 'collection.fetch-item',
  collectionFinalize: 'collection.finalize',
  processParse: 'process.parse',
  processExtract: 'process.extract',
  processOcr: 'process.ocr',
  processPreview: 'process.preview',
  processScan: 'process.scan',
  searchIndex: 'search.index',
  exportRun: 'export.run',
  productionRun: 'production.run',
  deletionRun: 'deletion.run',
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUE_NAMES: QueueName[] = Object.values(QUEUES);

/**
 * Exponential backoff with full jitter, capped. attempt is 1-based.
 * delay = random(0, min(cap, base * 2^(attempt-1)))
 */
export function backoffWithJitter(
  attempt: number,
  baseMs = 2_000,
  capMs = 5 * 60_000,
  random: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exp);
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'ev-jitter' },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: false,
};

/** Registered on each Worker instance. */
export const BACKOFF_STRATEGIES = {
  'ev-jitter': (attemptsMade: number): number => backoffWithJitter(attemptsMade),
};

/**
 * Deterministic dedup key builders. Stable across retries and redeploys so a
 * crashed producer re-emitting the same logical work cannot duplicate jobs.
 */
export const dedupKeys = {
  collectionDiscover: (collectionId: string) => `discover:${collectionId}`,
  collectionFetchPage: (
    collectionId: string,
    custodianId: string,
    source: string,
    scopeKey: string,
    cursorHash: string,
  ) => `page:${collectionId}:${custodianId}:${source}:${scopeKey}:${cursorHash}`,
  collectionFetchItem: (
    collectionId: string,
    custodianId: string,
    source: string,
    providerItemId: string,
  ) => `item:${collectionId}:${custodianId}:${source}:${providerItemId}`,
  collectionFinalize: (collectionId: string) => `finalize:${collectionId}`,
  processStage: (stage: string, evidenceItemId: string, version: number) =>
    `${stage}:${evidenceItemId}:v${version}`,
  /**
   * Each pipeline stage that enriches an item re-indexes it from current DB
   * truth. The stage is part of the dedup key so a later stage's re-index is
   * not collapsed against an earlier (less complete) one; the index write
   * itself is an idempotent upsert keyed by evidence id.
   */
  searchIndex: (evidenceItemId: string, version: number, stage = 'final') =>
    `index:${evidenceItemId}:v${version}:${stage}`,
  exportRun: (exportId: string) => `export:${exportId}`,
  productionRun: (productionRunId: string) => `production-run:${productionRunId}`,
  deletionRun: (deletionRequestId: string) => `deletion:${deletionRequestId}`,
};
