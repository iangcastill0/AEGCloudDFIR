import type { TenantScopedTx } from '@aeg-clouddfir/database';
import { RelationshipKind } from '@aeg-clouddfir/database';

const FAMILY_KINDS: RelationshipKind[] = [RelationshipKind.family, RelationshipKind.attachment];

/**
 * Ids per query.
 *
 * PostgreSQL's wire protocol carries the bind-parameter count in an int16, so
 * one statement can take at most 65,535 of them. expandFamilies sends each id
 * TWICE — once for parentId, once for childId — so the real ceiling here is
 * half of that.
 *
 * Found the hard way on staging: a production with an inverted selection and
 * includeFamilies passed 50,000 ids into a single query, which is 100,000
 * parameters. It failed in 618ms with a bare HTTP 500 and nothing in the log.
 *
 * 5,000 matches the chunk size productions already uses for the same reason,
 * and leaves an order of magnitude of headroom.
 */
export const FAMILY_QUERY_CHUNK = 5_000;

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
