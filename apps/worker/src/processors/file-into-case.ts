import { appendAuditEvent, withTenantContext } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { chunkIds } from '../chunked.js';
import { QUEUES, dedupKeys } from '../queues.js';

/**
 * File a finished collection's evidence into its case.
 *
 * Collecting was only ever half the job. The bytes have to end up somewhere a
 * reviewer can open, and that used to mean remembering to create a case and
 * add the collection to it by hand. Forgetting was silent: the collection
 * showed as completed while nothing in it was reviewable.
 *
 * This runs at finalize rather than per item on purpose. Membership is written
 * once for the whole collection instead of 43,379 times, and by finalize every
 * attachment child exists — filing as items arrived would have added parents
 * and missed the children that parse creates afterwards.
 */

/** Rows per insert. Matches the API's case-item insert size. */
const CASE_ITEM_CHUNK = 1_000;

export interface FiledIntoCase {
  caseId: string;
  added: number;
}

export async function fileCollectionIntoCase(
  ctx: WorkerContext,
  tenantId: string,
  collectionId: string,
  caseId: string | null,
): Promise<FiledIntoCase | null> {
  // Collections made before cases were automatic have none. Nothing to do,
  // and inventing one here would fabricate a decision nobody made.
  if (caseId === null) return null;

  try {
    const itemIds = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      const rows = await tx.evidenceItem.findMany({
        where: { collectionId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => r.id);
    });
    if (itemIds.length === 0) return { caseId, added: 0 };

    let added = 0;
    for (const batch of chunkIds(itemIds, CASE_ITEM_CHUNK)) {
      added += await withTenantContext(ctx.prisma, tenantId, async (tx) => {
        const result = await tx.caseItem.createMany({
          data: batch.map((evidenceItemId) => ({
            tenantId,
            caseId,
            evidenceItemId,
            // No actor: the worker filed these, not a person. A user id here
            // would claim someone chose each item individually.
            addedVia: 'collection',
          })),
          skipDuplicates: true,
        });

        // Case membership lives in the SEARCH document, built from the
        // database at index time — so an item joins a case and the case filter
        // in Review still finds nothing until it is re-indexed. See the outbox
        // note in CLAUDE.md: the dedup key must not collide with the indexing
        // this item already had, which is why it carries its own stage name.
        await tx.outboxEvent.createMany({
          data: batch.map((evidenceItemId) => ({
            tenantId,
            topic: QUEUES.searchIndex,
            dedupKey: dedupKeys.searchIndex(evidenceItemId, 1, 'case-auto'),
            payload: { tenantId, evidenceItemId, version: 1 },
          })),
          skipDuplicates: true,
        });
        return result.count;
      });
    }

    await withTenantContext(ctx.prisma, tenantId, (tx) =>
      appendAuditEvent(tx, {
        tenantId,
        action: 'case.items_added',
        targetType: 'case',
        targetId: caseId,
        actorDisplay: 'worker',
        summary: { addedVia: 'collection', collectionId, requested: itemIds.length, added },
      }),
    );

    ctx.log.info({ collectionId, caseId, added }, 'finalize: filed collection into its case');
    return { caseId, added };
  } catch (err) {
    // Filing is the last step and must never undo a finished collection. The
    // manifest is already signed and stored by this point; losing the case
    // membership is recoverable by adding the collection to the case by hand,
    // whereas throwing here would re-run finalize and re-sign the manifest.
    ctx.log.error(
      { collectionId, caseId, err: sanitizeError(err) },
      'finalize: could not file the collection into its case',
    );
    return null;
  }
}
