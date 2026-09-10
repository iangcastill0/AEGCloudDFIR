import type { TenantScopedTx } from '@aeg-clouddfir/database';
import { RelationshipKind } from '@aeg-clouddfir/database';

const FAMILY_KINDS: RelationshipKind[] = [RelationshipKind.family, RelationshipKind.attachment];

/**
 * Ids per query.
 *
 * Every id in an `in` (or `notIn`) list is one bind variable, and **Prisma
 * refuses a statement with more than 32,767 of them**:
 *
 *   Assertion violation on the database: too many bind variables in prepared
 *   statement, expected maximum of 32767, received 32768
 *
 * Note that ceiling. PostgreSQL's own wire protocol allows 65,535, and sizing
 * against the bigger number still breaks — Prisma stops at half of it.
 * expandFamilies also sends each id TWICE, once for parentId and once for
 * childId, halving it again.
 *
 * Found the hard way three times. A production with an inverted selection and
 * includeFamilies passed 50,000 ids into one query (100,000 parameters) and
 * failed in 618ms with a bare HTTP 500. Then adding a 43,379-item collection to
 * a case failed the same way. There is no size at which this is safe to skip:
 * a collection has no ceiling, so neither does any list derived from one.
 *
 * 5,000 leaves an order of magnitude of headroom.
 */
export const FAMILY_QUERY_CHUNK = 5_000;

/**
 * Run a query over an id list in safe-sized batches and concatenate the rows.
 *
 * Use this for EVERY query whose `in` list comes from a collection, a case, a
 * tag or a caller — none of those have an upper bound. Writing the `in` inline
 * works right up until a customer collects more than about thirty thousand
 * items, and then it is a 500 on the feature they most needed.
 *
 * Batches run in parallel; ordering of the returned rows is therefore the
 * ordering of the batches, not of the database. Sort afterwards when order
 * matters, exactly as a single query with no `orderBy` would require.
 */
export async function queryInChunks<T>(
  ids: readonly string[],
  run: (batch: string[]) => Promise<T[]>,
  size: number = FAMILY_QUERY_CHUNK,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const batches = await Promise.all(chunk(ids, size).map(run));
  return batches.flat();
}

/**
 * Expand evidence item ids to their families (parents AND children via
 * family/attachment relationships, both directions). Returns the input ids
 * plus every direct family member, de-duplicated.
 */
export async function expandFamilies(
  tx: TenantScopedTx,
  tenantId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const expanded = new Set<string>(ids);
  for (const batch of chunk(ids, FAMILY_QUERY_CHUNK)) {
    const relationships = await tx.evidenceRelationship.findMany({
      where: {
        tenantId,
        kind: { in: FAMILY_KINDS },
        OR: [{ parentId: { in: batch } }, { childId: { in: batch } }],
      },
      select: { parentId: true, childId: true },
    });
    for (const rel of relationships) {
      expanded.add(rel.parentId);
      expanded.add(rel.childId);
    }
  }
  return [...expanded];
}

/**
 * Expand ids to their direct children only (apply_to_descendants behavior).
 */
export async function expandDescendants(
  tx: TenantScopedTx,
  tenantId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const expanded = new Set<string>(ids);
  for (const batch of chunk(ids, FAMILY_QUERY_CHUNK)) {
    const relationships = await tx.evidenceRelationship.findMany({
      where: { tenantId, kind: { in: FAMILY_KINDS }, parentId: { in: batch } },
      select: { childId: true },
    });
    for (const rel of relationships) expanded.add(rel.childId);
  }
  return [...expanded];
}

/** Split an array into chunks of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
