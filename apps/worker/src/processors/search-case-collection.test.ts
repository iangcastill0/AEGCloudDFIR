import { describe, expect, it } from 'vitest';
import { fakeCtx, TENANT, COLLECTION } from '../testing/fakes.js';
import { caseCollectionPayload } from './payloads.js';
import { processSearchCaseCollection } from './search-case-collection.js';

const CASE = '99999999-9999-4999-8999-999999999999';

describe('processSearchCaseCollection', () => {
  it('asks the engine to stamp the case across the collection', async () => {
    const { ctx, search } = fakeCtx();

    await processSearchCaseCollection(ctx, {
      tenantId: TENANT,
      caseId: CASE,
      collectionId: COLLECTION,
    });

    // Argument order matters and is easy to get wrong: all three are uuids, so
    // a swap type-checks and silently stamps the wrong thing.
    expect(search.addCaseToCollection).toHaveBeenCalledWith(TENANT, COLLECTION, CASE);
  });

  it('touches nothing else', async () => {
    // Adding an item to a case says something about review scope, not about the
    // evidence. No ledger write, no progress counter, no further jobs — an
    // earlier version of this pipeline filed normal outcomes into the exception
    // ledger and buried the real gaps under 14,856 of them.
    const { ctx, tx, enqueue } = fakeCtx();

    await processSearchCaseCollection(ctx, {
      tenantId: TENANT,
      caseId: CASE,
      collectionId: COLLECTION,
    });

    expect(tx.collectionItem.updateMany).not.toHaveBeenCalled();
    expect(tx.evidenceItem.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets an engine failure reach the queue so the job retries', async () => {
    // Swallowing this would leave the case looking complete in the database
    // while Review could not find a single item in it.
    const { ctx, search } = fakeCtx();
    search.addCaseToCollection.mockRejectedValue(new Error('cluster_block_exception'));

    await expect(
      processSearchCaseCollection(ctx, {
        tenantId: TENANT,
        caseId: CASE,
        collectionId: COLLECTION,
      }),
    ).rejects.toThrow('cluster_block_exception');
  });
});

describe('caseCollectionPayload', () => {
  it('accepts the payload the API writes', () => {
    expect(
      caseCollectionPayload.parse({
        tenantId: TENANT,
        caseId: CASE,
        collectionId: COLLECTION,
        outboxEventId: 'ignored-bookkeeping',
      }),
    ).toEqual({ tenantId: TENANT, caseId: CASE, collectionId: COLLECTION });
  });

  it('rejects an id that is not a uuid', () => {
    // These go straight into a query filter; a malformed one should fail here
    // rather than quietly match nothing.
    expect(() =>
      caseCollectionPayload.parse({ tenantId: TENANT, caseId: 'nope', collectionId: COLLECTION }),
    ).toThrow();
  });
});
