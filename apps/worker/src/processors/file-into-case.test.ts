import { describe, expect, it } from 'vitest';
import { TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import { QUEUES } from '../queues.js';
import { fileCollectionIntoCase } from './file-into-case.js';

const COLLECTION = '00000000-0000-4000-8000-0000000000c1';
const CASE = '00000000-0000-4000-8000-0000000000ca';
const ITEM_A = '00000000-0000-4000-8000-0000000000a1';
const ITEM_B = '00000000-0000-4000-8000-0000000000a2';

/** One SQL page: inserted/scanned counts and the cursor for the next page. */
function page(inserted: number, scanned: number, lastId: string | null): unknown[] {
  return [{ inserted, scanned, lastId }];
}

function armPages(f: FakeCtx, pages: unknown[][]): void {
  let i = 0;
  f.tx.$queryRaw.mockImplementation(() => {
    const next = pages[i] ?? page(0, 0, null);
    i += 1;
    return Promise.resolve(next);
  });
  f.tx.outboxEvent.createMany.mockResolvedValue({ count: 1 });
}

describe('fileCollectionIntoCase', () => {
  it('files every item of the collection into the case via INSERT ... SELECT', async () => {
    const f = fakeCtx();
    armPages(f, [page(3, 3, ITEM_A)]);
    const result = await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(result).toEqual({ caseId: CASE, added: 3 });
    expect(f.tx.$queryRaw).toHaveBeenCalled();
    // No id list ever enters Node — that was the path that timed out at 434k.
    expect(f.tx.evidenceItem.findMany).not.toHaveBeenCalled();
    expect(f.tx.caseItem.createMany).not.toHaveBeenCalled();
  });

  it('re-indexes with one case-collection job, not one search.index per item', async () => {
    // Case membership is read from the SEARCH document. The old path queued
    // one full re-index per item (10-25 hours on a 434,910-item collection)
    // to append one string. One engine-side update is enough.
    const f = fakeCtx();
    armPages(f, [page(2, 2, ITEM_A)]);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    const events = f.tx.outboxEvent.createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: Record<string, unknown>[] }).data,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: QUEUES.searchCaseCollection,
      payload: { tenantId: TENANT, caseId: CASE, collectionId: COLLECTION },
    });
    expect(String(events[0]?.['dedupKey'])).toContain(`case-collection:${CASE}:${COLLECTION}:`);
  });

  it('pages a large collection instead of one giant statement', async () => {
    const f = fakeCtx();
    // Two full 25,000-row pages then a short one — mirrors the API path.
    armPages(f, [
      page(25_000, 25_000, ITEM_A),
      page(25_000, 25_000, ITEM_B),
      page(100, 100, '00000000-0000-4000-8000-0000000000a3'),
    ]);
    const result = await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(result).toEqual({ caseId: CASE, added: 50_100 });
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3);
    // Still exactly one index job for the whole collection.
    const events = f.tx.outboxEvent.createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: Record<string, unknown>[] }).data,
    );
    expect(events).toHaveLength(1);
  });

  it('does nothing for a collection made before cases were automatic', async () => {
    // Inventing a case for an old collection would fabricate a record of a
    // decision nobody made.
    const f = fakeCtx();
    armPages(f, [page(5, 5, ITEM_A)]);
    expect(await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, null)).toBeNull();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('handles a collection that preserved nothing', async () => {
    const f = fakeCtx();
    armPages(f, [page(0, 0, null)]);
    expect(await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE)).toEqual({
      caseId: CASE,
      added: 0,
    });
    // No index job for an empty filing — nothing to stamp.
    expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
    expect(f.tx.auditEvent.create).toHaveBeenCalled();
  });

  it('never lets a filing failure undo a finished collection', async () => {
    // The manifest is signed and stored by the time this runs. Throwing would
    // re-run finalize and re-sign it; a missing case membership is recoverable
    // by adding the collection to the case by hand.
    const f = fakeCtx();
    f.tx.$queryRaw.mockRejectedValue(new Error('database went away'));
    await expect(fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE)).resolves.toBeNull();
    expect(f.ctx.log.error).toHaveBeenCalled();
  });

  it('records the filing in the audit log', async () => {
    const f = fakeCtx();
    armPages(f, [page(4, 4, ITEM_A)]);
    await fileCollectionIntoCase(f.ctx, TENANT, COLLECTION, CASE);
    expect(f.tx.auditEvent.create).toHaveBeenCalled();
  });
});
