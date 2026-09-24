/**
 * Throughput maths and the state machine behind GET /collections/:id/throughput.
 *
 * Kept apart from the service, and pure, because this is the part with rules in
 * it. The service does SQL; everything that decides what a user is told lives
 * here where a test can hand it a situation and check the answer.
 *
 * The one rule above all others: nothing here predicts a finish time. Replaying
 * the biggest real run (185,379 provider items became 434,910 evidence items and
 * 130 GB, 2026-09-10 19:43 to 2026-09-14 16:56), a 5-minute measurement window
 * put the remaining time between -16% and +33% of the truth and a 30-minute
 * window between -25% and +68%. Even a low/high band missed at 4 of 9
 * checkpoints. So: elapsed, measured pace, counts, size. No forecast.
 */
import type {
  CollectionItemStateCounts,
  CollectionPhaseProgress,
  CollectionThroughputBucket,
  CollectionThroughputPace,
  CollectionThroughputState,
} from '@aeg-clouddfir/contracts';

/**
 * How long with nothing acquired before we say "stalled".
 *
 * Deliberately the same constant the worker's sweeper uses
 * (`STALL_AFTER_MS` in apps/worker/src/stalled-items.ts, 15 minutes). If the UI
 * used a shorter fuse it would shout "stalled" about work the sweeper has not
 * decided is stuck yet and is not re-driving — an alarm with no action behind
 * it, which is how people learn to ignore alarms.
 *
 * Duplicated as a number rather than imported: apps/api does not depend on
 * apps/worker, and a cross-app import would be the wrong fix. The test below
 * asserts the two agree.
 */
export const STALL_AFTER_MS = 15 * 60_000;

/** Under this many minutes measured, or this many items, state no pace at all. */
export const MIN_BUCKETS_FOR_PACE = 2;
export const MIN_ITEMS_FOR_PACE = 100;

/** How many recent buckets the "is right now slow" check averages over. */
export const RECENT_BUCKET_WINDOW = 5;

/**
 * Target bucket count for the whole-run window.
 *
 * The real run was 3,948 minutes. A browser draws the chart across roughly 900
 * pixels, so shipping every minute would send four points per pixel — a bigger
 * response, a slower parse, and not one extra thing visible.
 */
export const HISTORY_TARGET_BUCKETS = 200;

/** Terminal statuses: the run is over, whatever the outcome. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Statuses where the discovery walk has provably not finished. */
const DISCOVERY_STATUSES: ReadonlySet<string> = new Set(['created', 'discovering']);

/** One row as the rollup query returns it. */
export interface RawBucket {
  /** Bucket start, already truncated to the bucket width. */
  startedAt: Date;
  items: number;
  bytes: number;
}

/**
 * Bucket width for the whole-run window, in minutes.
 *
 * Always at least 1: a run shorter than the target count must not be widened
 * into fewer, coarser buckets than it has minutes.
 */
export function historyBucketMinutes(
  totalMinutes: number,
  target = HISTORY_TARGET_BUCKETS,
): number {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= target) return 1;
  return Math.ceil(totalMinutes / target);
}

/**
 * Fill the gaps and mark them.
 *
 * A minute that acquired nothing produces no row, so the raw result is the
 * non-empty minutes only. Drawing that straight would quietly close the gap and
 * make a stall look like steady work. The real run had 12 idle minutes out of
 * 3,948 and no gap over 5 minutes, so these are rare and worth seeing.
 */
export function fillBuckets(
  rows: RawBucket[],
  opts: { from: Date; to: Date; bucketMinutes: number; bytesBefore?: number },
): CollectionThroughputBucket[] {
  const widthMs = opts.bucketMinutes * 60_000;
  if (widthMs <= 0) return [];
  const startMs = Math.floor(opts.from.getTime() / widthMs) * widthMs;
  const endMs = Math.floor(opts.to.getTime() / widthMs) * widthMs;
  if (endMs < startMs) return [];

  const byStart = new Map<number, RawBucket>();
  for (const row of rows) {
    byStart.set(Math.floor(row.startedAt.getTime() / widthMs) * widthMs, row);
  }

  const out: CollectionThroughputBucket[] = [];
  let cumulative = opts.bytesBefore ?? 0;
  for (let ms = startMs, index = 0; ms <= endMs; ms += widthMs, index += 1) {
    const row = byStart.get(ms);
    const items = row?.items ?? 0;
    const bytes = row?.bytes ?? 0;
    cumulative += bytes;
    out.push({
      startedAt: new Date(ms).toISOString(),
      minutesFromStart: index * opts.bucketMinutes,
      items,
      bytes,
      cumulativeBytes: cumulative,
      idle: items === 0,
    });
  }
  return out;
}

/** Nearest-rank percentile of a sorted-on-the-way list. Empty list -> null. */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

/** Buckets whose whole width is in the past, so their count is final. */
export function completeBuckets(
  buckets: CollectionThroughputBucket[],
  opts: { now: Date; bucketMinutes: number },
): CollectionThroughputBucket[] {
  const widthMs = opts.bucketMinutes * 60_000;
  return buckets.filter((b) => Date.parse(b.startedAt) + widthMs <= opts.now.getTime());
}

/**
 * True while there is too little measured to state a pace.
 *
 * Both halves matter. Two full minutes with three items in them is a pace of
 * 1.5/min that means nothing, and one busy partial minute extrapolates to
 * whatever the clock happened to catch.
 */
export function isMeasuring(opts: { completeBucketCount: number; items: number }): boolean {
  return opts.completeBucketCount < MIN_BUCKETS_FOR_PACE || opts.items < MIN_ITEMS_FOR_PACE;
}

/** Every field null: "not measured yet", which is not the same claim as zero. */
export const EMPTY_PACE: CollectionThroughputPace = {
  itemsPerMinute: null,
  bytesPerMinute: null,
  p10ItemsPerMinute: null,
  p50ItemsPerMinute: null,
  p90ItemsPerMinute: null,
  peakItemsPerMinute: null,
};

/**
 * Measured pace over the complete buckets, plus this run's own spread.
 *
 * Returns all-null while measuring. Null, not zero: a zero on screen reads as
 * stalled, and the caller has an honest word for "we do not know yet".
 */
export function computePace(
  buckets: CollectionThroughputBucket[],
  opts: { measuring: boolean; bucketMinutes: number },
): CollectionThroughputPace {
  if (opts.measuring || buckets.length === 0) return EMPTY_PACE;
  const perBucketItems = buckets.map((b) => b.items);
  const totalItems = perBucketItems.reduce((n, v) => n + v, 0);
  const totalBytes = buckets.reduce((n, b) => n + b.bytes, 0);
  const minutes = buckets.length * opts.bucketMinutes;
  // Per-minute, not per-bucket: a downsampled history bucket is many minutes
  // wide, and reporting its total as a rate would overstate the pace by that
  // width — on the real run, by a factor of 20.
  const scale = 1 / opts.bucketMinutes;
  return {
    itemsPerMinute: totalItems / minutes,
    bytesPerMinute: totalBytes / minutes,
    p10ItemsPerMinute: scaleOrNull(percentile(perBucketItems, 0.1), scale),
    p50ItemsPerMinute: scaleOrNull(percentile(perBucketItems, 0.5), scale),
    p90ItemsPerMinute: scaleOrNull(percentile(perBucketItems, 0.9), scale),
    peakItemsPerMinute: scaleOrNull(Math.max(...perBucketItems), scale),
  };
}

function scaleOrNull(value: number | null, scale: number): number | null {
  return value === null ? null : value * scale;
}

/** Mean items per minute over the last few complete buckets. */
export function recentItemsPerMinute(
  buckets: CollectionThroughputBucket[],
  opts: { bucketMinutes: number; window?: number },
): number | null {
  const window = opts.window ?? RECENT_BUCKET_WINDOW;
  const tail = buckets.slice(-window);
  if (tail.length === 0) return null;
  const items = tail.reduce((n, b) => n + b.items, 0);
  return items / (tail.length * opts.bucketMinutes);
}

/**
 * Is right now slow for this run?
 *
 * The yardstick is the p10 of the buckets BEFORE the recent window, not of all
 * of them. That distinction is the whole function, and it was found by a test:
 * judge the last 5 minutes against a p10 that includes those same 5 minutes and
 * a long enough dip redefines "normal" and the warning can never fire. With 29
 * minutes at 101 items and then 5 at 10, the p10 of all 34 buckets IS 10, so
 * "below p10" is false at the exact moment it should be true.
 *
 * Needs a baseline at least as long as the recent window, so nothing is called
 * slow on the strength of one or two earlier minutes. The chart's shaded band
 * still uses the whole window's p10-p90 — that answers a different question
 * ("is this minute normal?") and wants every minute in it.
 */
export function isSlowNow(
  buckets: CollectionThroughputBucket[],
  opts: { bucketMinutes: number; window?: number },
): boolean {
  const window = opts.window ?? RECENT_BUCKET_WINDOW;
  const baseline = buckets.slice(0, -window);
  if (baseline.length < window) return false;
  const baselineP10 = percentile(
    baseline.map((b) => b.items / opts.bucketMinutes),
    0.1,
  );
  const recent = recentItemsPerMinute(buckets, opts);
  if (baselineP10 === null || baselineP10 <= 0 || recent === null) return false;
  return recent < baselineP10;
}

export type CollectionPhase = 'not_started' | 'acquisition' | 'processing' | 'finished';

/**
 * Which phase a collection is in.
 *
 * `preserved` is the hinge. An item in `preserved` has its bytes and is waiting
 * on parse/extract/OCR/index, so a collection with nothing left in
 * `discovered`/`fetching` but items still `preserved` is in the processing tail —
 * the 27.22 h of the real run that no screen currently shows.
 */
export function phaseOf(opts: {
  status: string;
  itemStates: CollectionItemStateCounts;
}): CollectionPhase {
  if (FINISHED_STATUSES.has(opts.status)) return 'finished';
  const s = opts.itemStates;
  const total =
    s.discovered + s.fetching + s.preserved + s.processed + s.indexed + s.failed + s.skipped;
  if (total === 0) return 'not_started';
  if (s.discovered + s.fetching > 0) return 'acquisition';
  // Nothing left to fetch. Whether items are still `preserved` or all settled,
  // the only work that can remain is the pipeline, so this is the tail.
  return 'processing';
}

/**
 * The denominator is still moving.
 *
 * Two separate reasons, and both are real. The status says discovery has not
 * finished; or a page checkpoint is still open, meaning the provider has more
 * pages this run has not walked. Either way a total is provisional, and a
 * percentage of a provisional total is a false statement — the real run's
 * 185,379 provider items ended up as 434,910 evidence items.
 */
export function isDiscovering(opts: { status: string; openPageCheckpoints: number }): boolean {
  return DISCOVERY_STATUSES.has(opts.status) || opts.openPageCheckpoints > 0;
}

export interface StateFacts {
  status: string;
  now: Date;
  /** Newest acquisition seen, or null if nothing has been acquired yet. */
  lastAcquiredAt: Date | null;
  itemStates: CollectionItemStateCounts;
  openPageCheckpoints: number;
  exceptionCount: number;
  rateLimitWaitMs: number;
  /** What the previous poll was told. null on a first poll. */
  previousRateLimitWaitMs: number | null;
  /** Complete buckets of the live window, oldest first. */
  buckets: CollectionThroughputBucket[];
  bucketMinutes: number;
  totalItems: number;
}

export interface StateDecision {
  state: CollectionThroughputState;
  /** The word beside the icon. Colour is never the only signal. */
  stateLabel: string;
  health: 'healthy' | 'attention' | 'problem';
  /** False means: show counts, show no rate. */
  showPace: boolean;
}

const STATE_LABELS: Record<CollectionThroughputState, string> = {
  measuring: 'Measuring',
  discovering: 'Discovering',
  fetching: 'Acquiring',
  processing: 'Processing',
  slow: 'Slower than usual for this run',
  rate_limited: 'Waiting on the provider',
  stalled: 'Stalled',
  finished: 'Finished',
};

/**
 * Decide, on the server, what the user is told.
 *
 * The order of these checks is the whole design, so it is written out:
 *
 * 1. Finished wins. A terminal collection is never described as working.
 * 2. Rate-limited beats stalled. A throttled collection is ALSO idle, and a red
 *    "stalled" on a healthy job that is politely waiting for Microsoft is the
 *    false alarm that teaches people to ignore the real one. Across the whole
 *    66 h acquisition, throttling totalled 8.45 minutes — so a rise really is a
 *    signal and not background noise.
 * 3. Stalled beats measuring. A young collection that has acquired nothing for
 *    15 minutes is stuck, not new, and the sweeper is already re-driving it.
 * 4. Measuring beats everything left, because a pace we cannot state must not be
 *    dressed up as one.
 * 5. Discovering, then slow, then the plain phase word.
 *
 * `showPace` is decided by the measurement, not by the state, so a stalled
 * three-minute-old collection says "Stalled" AND shows no invented rate.
 */
export function decideState(facts: StateFacts): StateDecision {
  const inFlight =
    facts.itemStates.discovered + facts.itemStates.fetching + facts.itemStates.preserved;
  const measuring = isMeasuring({
    completeBucketCount: facts.buckets.length,
    items: facts.totalItems,
  });
  const showPace = !measuring;
  const health = decideHealth(facts);

  const finish = (state: CollectionThroughputState): StateDecision => ({
    state,
    stateLabel: STATE_LABELS[state],
    health,
    showPace,
  });

  if (FINISHED_STATUSES.has(facts.status)) return finish('finished');

  const throttlingRose =
    facts.previousRateLimitWaitMs !== null && facts.rateLimitWaitMs > facts.previousRateLimitWaitMs;
  if (throttlingRose) return finish('rate_limited');

  const idleMs =
    facts.lastAcquiredAt === null ? null : facts.now.getTime() - facts.lastAcquiredAt.getTime();
  if (idleMs !== null && idleMs >= STALL_AFTER_MS && inFlight > 0) return finish('stalled');

  if (measuring) return finish('measuring');
  if (isDiscovering(facts)) return finish('discovering');

  const phase = phaseOf({ status: facts.status, itemStates: facts.itemStates });
  // "Slow" is relative to THIS run, never to a global number. The real run's own
  // p10 minute was 54 items and its p99 was 384; a fixed threshold would have
  // called its normal minutes slow and its slow minutes normal.
  if (phase === 'acquisition' && isSlowNow(facts.buckets, { bucketMinutes: facts.bucketMinutes })) {
    return finish('slow');
  }

  return finish(phase === 'processing' ? 'processing' : 'fetching');
}

/**
 * Health, and the invariant that made this a server field.
 *
 * An exception means something was not collected. A finished collection with
 * exceptions is therefore NEVER healthy, no matter how clean its counts look —
 * the page must link to the ledger instead of showing a green tick.
 */
function decideHealth(facts: StateFacts): 'healthy' | 'attention' | 'problem' {
  if (facts.status === 'failed') return 'problem';
  if (facts.itemStates.failed > 0) return 'problem';
  if (facts.exceptionCount > 0) return 'attention';
  if (facts.status === 'cancelled') return 'attention';
  return 'healthy';
}

/**
 * The two phases, each with its own progress and its own clock.
 *
 * Acquisition counts an item as done once its fetch settled, whatever happened
 * next. Processing counts only items whose pipeline finished. They overlap on
 * purpose: a real run is fetching some items while processing others, and
 * pretending otherwise is what hides the tail.
 */
export function phaseProgress(opts: {
  itemStates: CollectionItemStateCounts;
  denominatorMoving: boolean;
  acquisitionElapsedMs: number;
  runElapsedMs: number;
  acquisitionPace: CollectionThroughputPace;
  processingPace: CollectionThroughputPace;
}): { acquisition: CollectionPhaseProgress; processing: CollectionPhaseProgress } {
  const s = opts.itemStates;
  const all =
    s.discovered + s.fetching + s.preserved + s.processed + s.indexed + s.failed + s.skipped;

  const acquisitionDone = s.preserved + s.processed + s.indexed + s.failed + s.skipped;
  const processingTotal = s.preserved + s.processed + s.indexed;
  const processingDone = s.processed + s.indexed;

  return {
    acquisition: {
      phase: 'acquisition',
      done: acquisitionDone,
      total: opts.denominatorMoving ? null : all,
      percent: opts.denominatorMoving ? null : ratio(acquisitionDone, all),
      inFlight: s.discovered + s.fetching,
      elapsedMs: opts.acquisitionElapsedMs,
      pace: opts.acquisitionPace,
    },
    processing: {
      phase: 'processing',
      done: processingDone,
      total: opts.denominatorMoving ? null : processingTotal,
      percent: opts.denominatorMoving ? null : ratio(processingDone, processingTotal),
      inFlight: s.preserved,
      // The tail's own clock. On the real run this reached 27.22 h — 29% of a
      // 93.22 h run — entirely after the last byte arrived.
      elapsedMs: Math.max(opts.runElapsedMs - opts.acquisitionElapsedMs, 0),
      pace: opts.processingPace,
    },
  };
}

function ratio(done: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(done / total, 1) * 100;
}

/** Plain name for the measured window; the heading uses it verbatim. */
export function windowName(opts: {
  window: 'live' | 'history';
  bucketMinutes: number;
  bucketCount: number;
}): string {
  if (opts.window === 'live') return 'last 60 minutes, one bucket per minute';
  const each =
    opts.bucketMinutes === 1
      ? 'one bucket per minute'
      : `${String(opts.bucketMinutes)} minutes each`;
  return `whole run, ${String(opts.bucketCount)} buckets of ${each}`;
}
