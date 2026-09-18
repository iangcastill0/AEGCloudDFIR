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
 * How many batches may be in flight at once.
 *
 * `Promise.all` over every chunk is unbounded, and nothing bounds a collection.
 * A 434,910-item export expands to 174 batches, which meant 174 concurrent
 * queries against a Postgres already at 74% CPU. Six keeps the database busy
 * without turning one export into a denial of service against everything else
 * on the host.
 */
export const QUERY_CONCURRENCY = 6;

/**
 * Run a query over an id list in batches and concatenate the rows.
 *
 * Batches run concurrently up to `concurrency`, so the rows come back in
 * completion order rather than database order. Sort afterwards where order
 * matters.
 *
 * `run` is called once per batch and may open its own transaction. Prefer that
 * to wrapping the whole call in one: an interactive transaction is capped at 30
 * seconds, and 174 round trips inside it is how a 434,910-item export failed at
 * 30,244 ms with `Transaction already closed`.
 */
export async function queryInChunks<T>(
  ids: readonly string[],
  run: (batch: string[]) => Promise<T[]>,
  size: number = QUERY_ID_CHUNK,
  concurrency: number = QUERY_CONCURRENCY,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const batches = chunkIds(ids, size);
  const out: T[][] = new Array<T[]>(batches.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const batch = batches[i];
      if (batch === undefined) return;
      out[i] = await run(batch);
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, batches.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return out.flat();
}
