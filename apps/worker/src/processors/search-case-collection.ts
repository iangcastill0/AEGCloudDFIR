import type { WorkerContext } from '../context.js';
import type { CaseCollectionPayload } from './payloads.js';

/**
 * search.case-collection: add one case id to every document of one collection.
 *
 * This replaces queueing one re-index job per item when a whole collection
 * joins a case. A re-index rebuilds the entire search document — a database
 * read with eleven nested includes, plus a download of the item's extracted
 * text from object storage, then a bulk call carrying a single document. On a
 * 434,910-item collection that measured out at 10-25 hours of queue, all to
 * append one string to one field. The engine can do it in one request.
 *
 * Postgres stays the source of truth: `case_items` rows are written by the API
 * before this job is queued, and the indexer rebuilds `caseIds` from them. So
 * an item re-indexed later for any other reason reaches the same answer, and
 * an item that is not indexed yet picks the case id up when it first indexes.
 * This job only shortens the wait.
 *
 * Deliberately no ledger or progress writes: nothing about the evidence has
 * changed. Adding an item to a case is a statement about review scope, not
 * about the item.
 */
export async function processSearchCaseCollection(
  ctx: WorkerContext,
  payload: CaseCollectionPayload,
): Promise<void> {
  const { tenantId, caseId, collectionId } = payload;

  const result = await ctx.search.addCaseToCollection(tenantId, collectionId, caseId);

  ctx.log.info(
    {
      caseId,
      collectionId,
      updated: result.updated,
      unchanged: result.unchanged,
      conflicts: result.conflicts,
    },
    'case added to every indexed document in collection',
  );
}
