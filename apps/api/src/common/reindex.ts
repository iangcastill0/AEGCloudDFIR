import { randomUUID } from 'node:crypto';
import type { TenantScopedTx } from '@aeg-clouddfir/database';
import { chunk } from './families.js';

/** Rows per insert. Matches the other bulk paths in the API. */
const REINDEX_CHUNK = 500;

/**
 * Ask the worker to re-index evidence items after a change that alters what a
 * search should see — case membership, tag assignments — but does not change
 * the item itself.
 *
 * The index document is built from database truth at index time, so anything
 * that is only in the database until the next index run is invisible to search.
 * Case membership was exactly that: items were added to a case and the case
 * filter then matched nothing, because `caseIds` was never written to the
 * document. Verified on staging: a case with 49 items, and not one of their
 * documents carried a `caseIds` field.
 *
 * The dedup key carries a fresh token per call, deliberately. Outbox rows are
 * KEPT after dispatch and `(topic, dedupKey)` is unique, so a key built only
 * from the item and its version is a once-ever key: the second time that item
 * changes at the same version, `skipDuplicates` drops the row and the index
 * silently keeps its old answer. Neither adding to a case nor tagging bumps the
 * item's version, so that second time is the normal case, not an edge one.
 * A duplicate index run is harmless — the write is an idempotent upsert keyed by
 * evidence id — so erring toward dispatching is the safe direction.
 *
 * Returns how many events were written.
 */
export async function enqueueReindex(
  tx: TenantScopedTx,
  tenantId: string,
  evidenceItemIds: string[],
  reason: string,
  token: string = randomUUID(),
): Promise<number> {
  const ids = [...new Set(evidenceItemIds)];
  if (ids.length === 0) return 0;

  // The worker's payload contract carries the version it indexed at.
  const versions = await tx.evidenceItem.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, version: true },
  });

  let written = 0;
  for (const rows of chunk(versions, REINDEX_CHUNK)) {
    const result = await tx.outboxEvent.createMany({
      data: rows.map((row) => ({
        tenantId,
        topic: 'search.index',
        dedupKey: `index:${row.id}:v${row.version}:${reason}-${token}`,
        payload: { tenantId, evidenceItemId: row.id, version: row.version },
      })),
      skipDuplicates: true,
    });
    written += result.count;
  }
  return written;
}
