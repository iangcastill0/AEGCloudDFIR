import { QUEUES } from './queues.js';

/**
 * Decide what to do about a collection item that stopped moving.
 *
 * Why this exists: a collection is finished only when every item reaches a
 * settled state. Finalize waits on `discovered + fetching + preserved`, and a
 * FinalizeSweeper already re-asks the question every 30 seconds. But asking is
 * not fixing. When a deploy or an outage kills the worker mid-run, the items it
 * was holding keep their in-flight state and no job exists to move them again.
 * Finalize then waits forever and the sweeper spins forever.
 *
 * That is not hypothetical. One staging collection sat in `fetching` for five
 * hours with 2,335 items stranded in `discovered`, while the finalize sweeper
 * wrote 6,248 nudges over eight days that could never help.
 *
 * The rule that makes collections always terminate: retry a stranded item a
 * bounded number of times, then record it as a failure. A recorded failure is
 * honest and lets the collection close. An eternal `discovered` is neither.
 */

/**
 * How long an item may sit unchanged before it counts as stranded.
 *
 * Generous on purpose. A single large mailbox fetch or a slow Drive download
 * can legitimately run for minutes, and re-queueing a live job would duplicate
 * work and, worse, duplicate evidence.
 */
export const STALL_AFTER_MS = 15 * 60_000;

/** Recovery attempts before an item is written off as a failure. */
export const MAX_RECOVERY_ATTEMPTS = 3;

export type ItemState =
  'discovered' | 'fetching' | 'preserved' | 'processed' | 'indexed' | 'failed' | 'skipped';

export type RecoveryAction =
  | { kind: 'wait' }
  | { kind: 'requeue'; topic: string; stage: 'fetch' | 'index' }
  | { kind: 'give-up'; reason: string };

export interface StalledItemInput {
  state: ItemState;
  source: 'email' | 'drive' | 'audit';
  attempts: number;
  updatedAt: Date;
  evidenceItemId: string | null;
  now: Date;
}

/** States finalize already counts as settled. Touching one duplicates evidence. */
const IN_FLIGHT: ReadonlySet<ItemState> = new Set<ItemState>([
  'discovered',
  'fetching',
  'preserved',
]);

export function recoveryPlan(input: StalledItemInput): RecoveryAction {
  if (!IN_FLIGHT.has(input.state)) return { kind: 'wait' };

  const idleMs = input.now.getTime() - input.updatedAt.getTime();
  if (idleMs < STALL_AFTER_MS) return { kind: 'wait' };

  if (input.attempts >= MAX_RECOVERY_ATTEMPTS) {
    return {
      kind: 'give-up',
      reason:
        `could not recover this item after ${String(MAX_RECOVERY_ATTEMPTS)} attempts; ` +
        'it was left in flight by an interrupted run and is recorded as a failure',
    };
  }

  if (input.state === 'preserved') {
    // The bytes are stored, and indexing is the single step that settles the
    // item (search-index.ts is the only writer of state 'indexed').
    //
    // Re-queueing parse instead was the first attempt, and it moved nothing on
    // staging: parse ran, emitted its index job under a dedup key it had
    // already used, and that job was dropped — a key works once, ever. Parse is
    // also the stage that creates attachment children, so running it twice
    // duplicates evidence. Index directly, with a fresh token.
    if (input.evidenceItemId === null) {
      return {
        kind: 'give-up',
        // Retrying cannot help: there is nothing to index.
        reason:
          'item was marked preserved but carries no evidence row to index, ' +
          'so it cannot be recovered and is recorded as a failure',
      };
    }
    return { kind: 'requeue', topic: QUEUES.searchIndex, stage: 'index' };
  }

  // discovered or fetching: the fetch never finished, so run it again.
  return { kind: 'requeue', topic: QUEUES.collectionFetchItem, stage: 'fetch' };
}
