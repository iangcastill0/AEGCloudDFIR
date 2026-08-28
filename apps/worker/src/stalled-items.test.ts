import { describe, expect, it } from 'vitest';
import { QUEUES } from './queues.js';
import { MAX_RECOVERY_ATTEMPTS, STALL_AFTER_MS, recoveryPlan } from './stalled-items.js';

const NOW = new Date('2026-08-28T20:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - STALL_AFTER_MS - 60_000);
const JUST_NOW = new Date(NOW.getTime() - 5_000);

function item(over: Partial<Parameters<typeof recoveryPlan>[0]> = {}) {
  return recoveryPlan({
    state: 'discovered',
    source: 'email',
    attempts: 0,
    updatedAt: LONG_AGO,
    evidenceItemId: null,
    now: NOW,
    ...over,
  });
}

describe('recoveryPlan', () => {
  it('re-fetches an item stranded in discovered', () => {
    // The real failure: 2,335 items sat in 'discovered' for five hours after a
    // deploy killed the worker mid-run. Nothing was ever going to move them.
    const plan = item({ state: 'discovered' });
    expect(plan).toEqual({
      kind: 'requeue',
      topic: QUEUES.collectionFetchItem,
      stage: 'fetch',
    });
  });

  it('re-fetches an item stranded mid-fetch', () => {
    // 'fetching' means a worker claimed it and died holding it.
    expect(item({ state: 'fetching' }).kind).toBe('requeue');
  });

  it('resumes processing for a preserved item, by source', () => {
    // Bytes are stored; only the processing stage was lost. Email parses,
    // everything else extracts — the same split collection-fetch-item makes.
    expect(item({ state: 'preserved', source: 'email', evidenceItemId: 'e1' })).toEqual({
      kind: 'requeue',
      topic: QUEUES.processParse,
      stage: 'parse',
    });
    expect(item({ state: 'preserved', source: 'drive', evidenceItemId: 'e1' })).toEqual({
      kind: 'requeue',
      topic: QUEUES.processExtract,
      stage: 'extract',
    });
  });

  it('gives up on a preserved item with no evidence row to process', () => {
    // Nothing to point the parse job at. Retrying cannot help, and leaving it
    // in flight blocks finalize forever.
    const plan = item({ state: 'preserved', evidenceItemId: null });
    expect(plan.kind).toBe('give-up');
  });

  it('leaves alone anything that is still recent', () => {
    // A live job must never be double-queued just because it is slow. A large
    // mailbox fetch can legitimately take minutes.
    expect(item({ updatedAt: JUST_NOW }).kind).toBe('wait');
    expect(item({ state: 'preserved', evidenceItemId: 'e1', updatedAt: JUST_NOW }).kind).toBe(
      'wait',
    );
  });

  it('never touches an item that already settled', () => {
    // These are the states finalize counts as done. Re-queueing one would
    // duplicate evidence.
    for (const state of ['processed', 'indexed', 'failed', 'skipped'] as const) {
      expect(item({ state }).kind, state).toBe('wait');
    }
  });

  it('stops retrying and gives up, so a collection can always finish', () => {
    // The point of the whole exercise. An item that cannot be recovered has to
    // become a recorded failure, not an eternal blocker.
    expect(item({ attempts: MAX_RECOVERY_ATTEMPTS }).kind).toBe('give-up');
    expect(item({ attempts: MAX_RECOVERY_ATTEMPTS + 5 }).kind).toBe('give-up');
    expect(item({ attempts: MAX_RECOVERY_ATTEMPTS - 1 }).kind).toBe('requeue');
  });

  it('says why it gave up, in words that belong in an exception ledger', () => {
    const plan = item({ attempts: MAX_RECOVERY_ATTEMPTS });
    expect(plan.kind).toBe('give-up');
    if (plan.kind !== 'give-up') return;
    expect(plan.reason).toContain('recover');
    // Never an unqualified claim about what was collected.
    expect(plan.reason).not.toMatch(/\bcomplete\b/i);
  });

  it('treats the stall threshold as a boundary, not a suggestion', () => {
    const exactly = new Date(NOW.getTime() - STALL_AFTER_MS);
    expect(item({ updatedAt: exactly }).kind).toBe('requeue');
    const oneMsShort = new Date(NOW.getTime() - STALL_AFTER_MS + 1);
    expect(item({ updatedAt: oneMsShort }).kind).toBe('wait');
  });
});
