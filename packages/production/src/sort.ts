import type { ProductionSortKey } from './types.js';

/** The fields the production sorter needs from each candidate item. */
export interface SortableProductionItem {
  evidenceId: string;
  fileName: string;
  folderPath: string;
  /** ISO-8601 primary date, or null when unknown. */
  primaryDate: string | null;
  custodian: string | null;
  familyId: string | null;
  isFamilyChild: boolean;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** null dates sort after all real dates, regardless of direction. */
function compareNullableDate(a: string | null, b: string | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * compareStrings(a, b);
}

function keyComparator(
  sortKey: ProductionSortKey,
): (a: SortableProductionItem, b: SortableProductionItem) => number {
  switch (sortKey) {
    case 'folder_filename':
      return (a, b) =>
        compareStrings(a.folderPath, b.folderPath) || compareStrings(a.fileName, b.fileName);
    case 'filename':
      return (a, b) => compareStrings(a.fileName, b.fileName);
    case 'primary_date_asc':
      return (a, b) => compareNullableDate(a.primaryDate, b.primaryDate, 1);
    case 'primary_date_desc':
      return (a, b) => compareNullableDate(a.primaryDate, b.primaryDate, -1);
    case 'custodian':
      return (a, b) => compareStrings(a.custodian ?? '', b.custodian ?? '');
    case 'evidence_id':
      return () => 0; // tiebreak below handles it
  }
}

/**
 * Sort production candidates.
 *
 * When `familyGrouping` is true, family adjacency is always preserved: family
 * heads are sorted by the key among all other items, and children immediately
 * follow their head ordered by evidenceId — a family never splits. When false,
 * every item sorts independently by the key.
 *
 * Ties always break deterministically by evidenceId.
 */
export function sortProductionItems<T extends SortableProductionItem>(
  items: readonly T[],
  sortKey: ProductionSortKey,
  familyGrouping: boolean,
): T[] {
  const byKey = keyComparator(sortKey);
  const compare = (a: T, b: T): number =>
    byKey(a, b) || compareStrings(a.evidenceId, b.evidenceId);

  if (!familyGrouping) {
    return [...items].sort(compare);
  }

  interface Group {
    head: T;
    children: T[];
  }

  const standalone: Group[] = [];
  const families = new Map<string, T[]>();
  for (const item of items) {
    if (item.familyId === null) {
      standalone.push({ head: item, children: [] });
    } else {
      const members = families.get(item.familyId);
      if (members) members.push(item);
      else families.set(item.familyId, [item]);
    }
  }

  const groups: Group[] = [...standalone];
  for (const members of families.values()) {
    const parents = members.filter((m) => !m.isFamilyChild).sort(compare);
    const children = members
      .filter((m) => m.isFamilyChild)
      .sort((a, b) => compareStrings(a.evidenceId, b.evidenceId));
    if (parents.length === 0) {
      // Orphaned children: the lowest evidenceId child leads the group so the
      // family still stays together deterministically.
      const [head, ...rest] = children;
      if (head !== undefined) groups.push({ head, children: rest });
    } else {
      const [head, ...extraParents] = parents;
      if (head !== undefined) {
        // Any additional non-child members follow the head before children.
        groups.push({ head, children: [...extraParents, ...children] });
      }
    }
  }

  groups.sort((a, b) => compare(a.head, b.head));
  return groups.flatMap((g) => [g.head, ...g.children]);
}
