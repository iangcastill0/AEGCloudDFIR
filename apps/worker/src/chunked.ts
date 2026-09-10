/**
 * Safe-sized `in` lists.
 *
 * Every id in an `in` (or `notIn`) list is one bind variable, and Prisma
 * refuses a statement carrying more than 32,767 of them:
 *
 *   Assertion violation on the database: too many bind variables in prepared
 *   statement, expected maximum of 32767, received 32768
 *
 * That ceiling is Prisma's, not PostgreSQL's — the wire protocol allows 65,535,
 * and sizing against the bigger number still breaks.
 *
 * This matters here more than anywhere. Nothing bounds how much a collection
 * acquires, so nothing bounds a case, an export or a production built from one.
 * A 43,379-item collection failed to export before writing a byte, and its
 * family expansion failed earlier still, because that query sends every id
 * twice — once for parentId, once for childId — which is 86,758 parameters.
 *
 * The API has its own copy of this in `apps/api/src/common/families.ts`. They
 * are duplicated deliberately: the two apps do not share a runtime module, and
 * a shared package for one function would be worse than the repetition.
 */

/** Ids per query. An order of magnitude below the ceiling, halved again for
 * queries that mention each id twice. */
export const QUERY_ID_CHUNK = 5_000;

export function chunkIds<T>(items: readonly T[], size: number = QUERY_ID_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Run a query over an id list in batches and concatenate the rows.
 *
 * Batches run in parallel, so the rows come back in batch order rather than
 * database order. Sort afterwards where order matters.
 */
export async function queryInChunks<T>(
  ids: readonly string[],
  run: (batch: string[]) => Promise<T[]>,
  size: number = QUERY_ID_CHUNK,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const batches = await Promise.all(chunkIds(ids, size).map(run));
  return batches.flat();
}
