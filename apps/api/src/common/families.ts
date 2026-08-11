import type { TenantScopedTx } from '@evidencevault/database';
import { RelationshipKind } from '@evidencevault/database';

const FAMILY_KINDS: RelationshipKind[] = [RelationshipKind.family, RelationshipKind.attachment];

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
  const relationships = await tx.evidenceRelationship.findMany({
    where: {
      tenantId,
      kind: { in: FAMILY_KINDS },
      OR: [{ parentId: { in: [...ids] } }, { childId: { in: [...ids] } }],
    },
    select: { parentId: true, childId: true },
  });
  const expanded = new Set<string>(ids);
  for (const rel of relationships) {
    expanded.add(rel.parentId);
    expanded.add(rel.childId);
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
  const relationships = await tx.evidenceRelationship.findMany({
    where: { tenantId, kind: { in: FAMILY_KINDS }, parentId: { in: [...ids] } },
    select: { childId: true },
  });
  const expanded = new Set<string>(ids);
  for (const rel of relationships) expanded.add(rel.childId);
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
