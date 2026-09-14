import { describe, expect, it } from 'vitest';
import { TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import { fileCollectionIntoCase } from './file-into-case.js';

const COLLECTION = '00000000-0000-4000-8000-0000000000c1';
const CASE = '00000000-0000-4000-8000-0000000000ca';

function itemIds(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
  }));
}

function arm(f: FakeCtx, count: number): void {
  f.tx.evidenceItem.findMany.mockResolvedValue(itemIds(count));
  f.tx.caseItem.createMany.mockImplementation((args: { data: unknown[] }) =>
    Promise.resolve({ count: args.data.length }),
  );
  f.tx.outboxEvent.createMany.mockResolvedValue({ count: 0 });
}

/** Every row the run tried to insert into case_items. */
function caseRows(f: FakeCtx): Record<string, unknown>[] {
  return f.tx.caseItem.createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Record<string, unknown>[] }).data,
  );
}

describe('fileCollectionIntoCase', () => {
  it('files every item of the collection into the case', async () => {
    const f = fakeCtx();
    arm(f, 3);
    const result = await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(result).toEqual({ caseId: CASE, added: 3 });
    expect(caseRows(f)).toHaveLength(3);
    expect(caseRows(f)[0]).toMatchObject({ caseId: CASE, addedVia: 'collection' });
  });

  it('re-indexes what it filed, or the case filter finds nothing', async () => {
    // Case membership is read from the SEARCH document, which is built from
    // the database at index time. Items joined a case and Review's case filter
    // matched none of them, because caseIds never reached the document.
    const f = fakeCtx();
    arm(f, 2);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    const events = f.tx.outboxEvent.createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: Record<string, unknown>[] }).data,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ topic: 'search.index' });
    // Its own stage name, so it cannot collide with the indexing the item
    // already had — a dedup key works once, ever.
    expect(String(events[0]?.['dedupKey'])).toContain('case-auto');
  });

  it('claims no actor — a person did not pick these items', async () => {
    const f = fakeCtx();
    arm(f, 1);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(caseRows(f)[0]).not.toHaveProperty('addedById');
  });

  it('chunks a large collection instead of one giant insert', async () => {
    // A collection has no upper bound: a real one held 43,379 items.
    const f = fakeCtx();
    arm(f, 2_500);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(f.tx.caseItem.createMany.mock.calls.length).toBeGreaterThan(1);
    for (const call of f.tx.caseItem.createMany.mock.calls) {
      expect((call[0] as { data: unknown[] }).data.length).toBeLessThanOrEqual(1_000);
    }
    expect(caseRows(f)).toHaveLength(2_500);
  });

  it('does nothing for a collection made before cases were automatic', async () => {
    // Inventing a case for an old collection would fabricate a record of a
    // decision nobody made.
    const f = fakeCtx();
    arm(f, 5);
    expect(await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, null)).toBeNull();
    expect(f.tx.caseItem.createMany).not.toHaveBeenCalled();
  });

  it('handles a collection that preserved nothing', async () => {
    const f = fakeCtx();
    arm(f, 0);
    expect(await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE)).toEqual({
      caseId: CASE,
      added: 0,
    });
    expect(f.tx.caseItem.createMany).not.toHaveBeenCalled();
  });

  it('never lets a filing failure undo a finished collection', async () => {
    // The manifest is signed and stored by the time this runs. Throwing would
    // re-run finalize and re-sign it; a missing case membership is recoverable
    // by adding the collection to the case by hand.
    const f = fakeCtx();
    arm(f, 2);
    f.tx.caseItem.createMany.mockRejectedValue(new Error('database went away'));
    await expect(fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE)).resolves.toBeNull();
    expect(f.ctx.log.error).toHaveBeenCalled();
  });

  it('records the filing in the audit log', async () => {
    const f = fakeCtx();
    arm(f, 4);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(f.tx.auditEvent.create).toHaveBeenCalled();
  });
});
