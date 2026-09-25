import { randomUUID } from 'node:crypto';
import { appendAuditEvent, withTenantContext } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { QUEUES } from '../queues.js';

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
 *
 * Scale
 * -----
 * The first version loaded every evidence id into Node, inserted case_items in
 * chunks of 1,000, and queued one `search.index` per item. That is the same
 * shape the API used to use, and it was measured on a 434,910-item collection:
 * ~1,400 database round trips and 10-25 hours of re-index queue, all to append
 * one string to one search field. Finalize then also swallowed a timeout on the
 * initial `findMany` of every id, so a large collection could finish with an
 * empty case and only a log line saying so.
 *
 * Membership is now one INSERT ... SELECT per page (same SQL as the API's
 * addWholeCollection), and the index is told once via `search.case-collection`.
 * Postgres stays the source of truth; the engine-side stamp only shortens the
 * wait for documents that are already indexed.
 */

/**
 * Rows per statement. Matches the API's collection-to-case page size: nothing
 * crosses into Node, so a page is one short statement rather than a thousand.
 */
const COLLECTION_INSERT_CHUNK = 25_000;

/** Sorts before every real uuid, so the first page needs no special case. */
const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

interface CollectionInsertPage {
  inserted: number;
  scanned: number;
  lastId: string | null;
}

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
    let added = 0;
    let requested = 0;
    let cursor = UUID_ZERO;

    for (;;) {
      const page = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
        const rows = await tx.$queryRaw<CollectionInsertPage[]>`
          WITH batch AS (
            SELECT e."id", e."tenantId"
              FROM evidence_items e
             WHERE e."tenantId" = ${tenantId}::uuid
               AND e."collectionId" = ${collectionId}::uuid
               AND e."id" > ${cursor}::uuid
             ORDER BY e."id"
             LIMIT ${COLLECTION_INSERT_CHUNK}
          ), inserted AS (
            INSERT INTO case_items ("id", "tenantId", "caseId", "evidenceItemId", "addedVia")
            SELECT gen_random_uuid(), b."tenantId", ${caseId}::uuid, b."id", 'collection'
              FROM batch b
            ON CONFLICT ("caseId", "evidenceItemId") DO NOTHING
            RETURNING 1
          )
          SELECT (SELECT count(*) FROM inserted)::int AS "inserted",
                 (SELECT count(*) FROM batch)::int    AS "scanned",
                 (SELECT max(b."id") FROM batch b)    AS "lastId"`;
        return rows[0] ?? { inserted: 0, scanned: 0, lastId: null };
      });

      added += page.inserted;
      requested += page.scanned;
      // A short page is the end. `lastId` is null only on an empty page, and
      // without a cursor the next statement would repeat this one forever.
      if (page.scanned < COLLECTION_INSERT_CHUNK || page.lastId === null) break;
      cursor = page.lastId;
    }

    // One job, not one per item. Queued AFTER the rows are committed so the
    // worker stamps documents from the collection id while case_items already
    // agree — anything re-indexed later rebuilds caseIds from those rows.
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      if (requested > 0) {
        await tx.outboxEvent.createMany({
          data: [
            {
              tenantId,
              topic: QUEUES.searchCaseCollection,
              // Fresh token: a key of only case+collection would work once ever
              // and every later auto-file of the same pair would be dropped.
              dedupKey: `case-collection:${caseId}:${collectionId}:${randomUUID()}`,
              payload: { tenantId, caseId, collectionId },
            },
          ],
          skipDuplicates: true,
        });
      }

      await appendAuditEvent(tx, {
        tenantId,
        action: 'case.items_added',
        targetType: 'case',
        targetId: caseId,
        actorDisplay: 'worker',
        summary: { addedVia: 'collection', collectionId, requested, added },
      });
    });

    ctx.log.info(
      { collectionId, caseId, added, requested },
      'finalize: filed collection into its case',
    );
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
