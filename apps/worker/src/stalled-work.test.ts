import { describe, expect, it } from 'vitest';
import { QUEUES } from './queues.js';
import {
  MAX_RECOVERY_ATTEMPTS,
  STALL_AFTER_MS,
  pageWalkPlan,
  unparsedParentPlan,
} from './stalled-items.js';

const STALE = STALL_AFTER_MS + 60_000;

/**
 * Finalize waits on three things, not one: items in flight, page checkpoints,
 * and parents still awaiting parse. Recovering only the items left a staging
 * collection stuck for 8h20m with every item settled, 5 frozen page
 * checkpoints and 2 unparsed emails. These cover the other two.
 */
describe('pageWalkPlan', () => {
  it('resumes a page walk that was interrupted mid-folder', () => {
    // The real case: INBOX, Sent, Draft, Archive and Notes/Abicode all froze at
    // 15:07 when the worker died. Each says "there are more pages here".
    expect(pageWalkPlan({ idleMs: STALE, priorAttempts: 0 })).toEqual({
      kind: 'requeue',
      topic: QUEUES.collectionFetchPage,
      stage: 'page',
    });
  });

  it('leaves a checkpoint alone while its walk is still moving', () => {
    // Paging updates the checkpoint on every page. A recent one is live work.
    expect(pageWalkPlan({ idleMs: 30_000, priorAttempts: 0 }).kind).toBe('wait');
  });

  it('gives up rather than retrying a folder forever', () => {
    const plan = pageWalkPlan({ idleMs: STALE, priorAttempts: MAX_RECOVERY_ATTEMPTS });
    expect(plan.kind).toBe('give-up');
    if (plan.kind !== 'give-up') return;
    // The reason is read by a person deciding whether to re-run the collection.
    expect(plan.reason).toMatch(/pag/i);
  });

  it('never claims the folder was fully collected', () => {
    // Dropping a checkpoint unblocks finalize but means mail was NOT collected.
    // The wording has to carry that, because the manifest is a legal artefact.
    const plan = pageWalkPlan({ idleMs: STALE, priorAttempts: MAX_RECOVERY_ATTEMPTS });
    if (plan.kind !== 'give-up') throw new Error('expected give-up');
    expect(plan.reason).not.toMatch(/\bcomplete\b/i);
    expect(plan.reason).toMatch(/not collected|incomplete|may be missing/i);
  });
});

describe('unparsedParentPlan', () => {
  it('re-parses a parent stuck pending', () => {
    // Parse creates attachment children, so finalize gates on it directly.
    // Two emails sat pending from 16:26 and blocked the whole collection.
    expect(unparsedParentPlan({ idleMs: STALE, priorAttempts: 0 })).toEqual({
      kind: 'requeue',
      topic: QUEUES.processParse,
      stage: 'parse',
    });
  });

  it('leaves a recently created parent alone', () => {
    expect(unparsedParentPlan({ idleMs: 1_000, priorAttempts: 0 }).kind).toBe('wait');
  });

  it('gives up after the same bounded number of attempts', () => {
    expect(unparsedParentPlan({ idleMs: STALE, priorAttempts: MAX_RECOVERY_ATTEMPTS }).kind).toBe(
      'give-up',
    );
    expect(
      unparsedParentPlan({ idleMs: STALE, priorAttempts: MAX_RECOVERY_ATTEMPTS - 1 }).kind,
    ).toBe('requeue');
  });

  it('says its children may be missing, because parse is what creates them', () => {
    const plan = unparsedParentPlan({ idleMs: STALE, priorAttempts: MAX_RECOVERY_ATTEMPTS });
    if (plan.kind !== 'give-up') throw new Error('expected give-up');
    expect(plan.reason).toMatch(/attachment|child/i);
  });
});
