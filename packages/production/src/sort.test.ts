import { describe, expect, it } from 'vitest';
import { sortProductionItems, type SortableProductionItem } from './sort.js';
import type { ProductionSortKey } from './types.js';

function item(
  overrides: Partial<SortableProductionItem> & { evidenceId: string },
): SortableProductionItem {
  return {
    fileName: 'file.txt',
    folderPath: '/root',
    primaryDate: null,
    custodian: null,
    familyId: null,
    isFamilyChild: false,
    ...overrides,
  };
}

/** Deterministic PRNG so the property-style shuffle test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

const ALL_KEYS: ProductionSortKey[] = [
  'folder_filename',
  'filename',
  'primary_date_asc',
  'primary_date_desc',
  'custodian',
  'evidence_id',
];

describe('sortProductionItems', () => {
  it('sorts by folder then filename', () => {
    const items = [
      item({ evidenceId: 'e1', folderPath: '/b', fileName: 'a.txt' }),
      item({ evidenceId: 'e2', folderPath: '/a', fileName: 'z.txt' }),
      item({ evidenceId: 'e3', folderPath: '/a', fileName: 'a.txt' }),
    ];
    expect(sortProductionItems(items, 'folder_filename', true).map((i) => i.evidenceId)).toEqual([
      'e3',
      'e2',
      'e1',
    ]);
  });

  it('sorts by filename', () => {
    const items = [
      item({ evidenceId: 'e1', fileName: 'c.txt' }),
      item({ evidenceId: 'e2', fileName: 'a.txt' }),
      item({ evidenceId: 'e3', fileName: 'b.txt' }),
    ];
    expect(sortProductionItems(items, 'filename', true).map((i) => i.evidenceId)).toEqual([
      'e2',
      'e3',
      'e1',
    ]);
  });

  it('sorts by primary date ascending and descending, nulls always last', () => {
    const items = [
      item({ evidenceId: 'e1', primaryDate: '2024-05-01T00:00:00Z' }),
      item({ evidenceId: 'e2', primaryDate: null }),
      item({ evidenceId: 'e3', primaryDate: '2023-01-01T00:00:00Z' }),
    ];
    expect(sortProductionItems(items, 'primary_date_asc', true).map((i) => i.evidenceId)).toEqual([
      'e3',
      'e1',
      'e2',
    ]);
    expect(sortProductionItems(items, 'primary_date_desc', true).map((i) => i.evidenceId)).toEqual([
      'e1',
      'e3',
      'e2',
    ]);
  });

  it('sorts by custodian', () => {
    const items = [
      item({ evidenceId: 'e1', custodian: 'Smith' }),
      item({ evidenceId: 'e2', custodian: 'Adams' }),
      item({ evidenceId: 'e3', custodian: 'Jones' }),
    ];
    expect(sortProductionItems(items, 'custodian', true).map((i) => i.evidenceId)).toEqual([
      'e2',
      'e3',
      'e1',
    ]);
  });

  it('sorts by evidence id', () => {
    const items = [
      item({ evidenceId: 'e3' }),
      item({ evidenceId: 'e1' }),
      item({ evidenceId: 'e2' }),
    ];
    expect(sortProductionItems(items, 'evidence_id', true).map((i) => i.evidenceId)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
  });

  it('breaks ties deterministically by evidenceId', () => {
    const items = [
      item({ evidenceId: 'e9', fileName: 'same.txt' }),
      item({ evidenceId: 'e1', fileName: 'same.txt' }),
      item({ evidenceId: 'e5', fileName: 'same.txt' }),
    ];
    expect(sortProductionItems(items, 'filename', true).map((i) => i.evidenceId)).toEqual([
      'e1',
      'e5',
      'e9',
    ]);
  });

  it('children immediately follow their parent, ordered by evidenceId', () => {
    const items = [
      item({ evidenceId: 'c2', familyId: 'F1', isFamilyChild: true, fileName: 'attachment-z.pdf' }),
      item({ evidenceId: 'p1', familyId: 'F1', fileName: 'm-email.msg' }),
      item({ evidenceId: 'c1', familyId: 'F1', isFamilyChild: true, fileName: 'a-attachment.pdf' }),
      item({ evidenceId: 's1', fileName: 'z-standalone.txt' }),
      item({ evidenceId: 's0', fileName: 'a-standalone.txt' }),
    ];
    expect(sortProductionItems(items, 'filename', true).map((i) => i.evidenceId)).toEqual([
      's0',
      'p1', // parent sorted by its own filename; children follow by evidenceId
      'c1',
      'c2',
      's1',
    ]);
  });

  it('preserves family adjacency under every key with shuffled input (property)', () => {
    const rand = mulberry32(0xbeef);
    const base: SortableProductionItem[] = [];
    for (let f = 0; f < 6; f += 1) {
      base.push(
        item({
          evidenceId: `p${f}`,
          familyId: `F${f}`,
          fileName: `parent-${(9 - f) % 7}.msg`,
          folderPath: `/f${f % 3}`,
          primaryDate: f % 4 === 0 ? null : `202${f % 3}-0${(f % 9) + 1}-01T00:00:00Z`,
          custodian: ['Adams', 'Jones', null][f % 3] ?? null,
        }),
      );
      for (let c = 0; c < (f % 3) + 1; c += 1) {
        base.push(
          item({
            evidenceId: `c${f}-${c}`,
            familyId: `F${f}`,
            isFamilyChild: true,
            fileName: `att-${c}.pdf`,
            primaryDate: null,
          }),
        );
      }
    }
    for (let s = 0; s < 5; s += 1) {
      base.push(item({ evidenceId: `s${s}`, fileName: `loose-${s}.txt` }));
    }

    for (const key of ALL_KEYS) {
      let previous: string[] | null = null;
      for (let trial = 0; trial < 5; trial += 1) {
        const result = sortProductionItems(shuffled(base, rand), key, true);
        expect(result).toHaveLength(base.length);
        // Adjacency invariant: all members of a family occupy consecutive slots.
        const firstSeen = new Map<string, number>();
        const lastSeen = new Map<string, number>();
        const sizes = new Map<string, number>();
        result.forEach((r, index) => {
          if (r.familyId === null) return;
          if (!firstSeen.has(r.familyId)) firstSeen.set(r.familyId, index);
          lastSeen.set(r.familyId, index);
          sizes.set(r.familyId, (sizes.get(r.familyId) ?? 0) + 1);
        });
        for (const [familyId, first] of firstSeen) {
          const last = lastSeen.get(familyId) ?? first;
          const size = sizes.get(familyId) ?? 0;
          expect(last - first + 1).toBe(size); // never splits
          // Parent leads its family.
          expect(result[first]?.evidenceId).toBe(familyId.replace('F', 'p'));
        }
        // Determinism regardless of input order.
        const ids = result.map((r) => r.evidenceId);
        if (previous !== null) expect(ids).toEqual(previous);
        previous = ids;
      }
    }
  });

  it('keeps orphaned children together when their parent is absent', () => {
    const items = [
      item({ evidenceId: 'c9', familyId: 'F1', isFamilyChild: true, fileName: 'z.pdf' }),
      item({ evidenceId: 'c1', familyId: 'F1', isFamilyChild: true, fileName: 'a.pdf' }),
      item({ evidenceId: 's1', fileName: 'b.txt' }),
    ];
    const ids = sortProductionItems(items, 'filename', true).map((i) => i.evidenceId);
    const c1 = ids.indexOf('c1');
    expect(ids[c1 + 1]).toBe('c9');
  });

  it('sorts flat when familyGrouping is false', () => {
    const items = [
      item({ evidenceId: 'p1', familyId: 'F1', fileName: 'z.msg' }),
      item({ evidenceId: 'c1', familyId: 'F1', isFamilyChild: true, fileName: 'a.pdf' }),
      item({ evidenceId: 's1', fileName: 'm.txt' }),
    ];
    expect(sortProductionItems(items, 'filename', false).map((i) => i.evidenceId)).toEqual([
      'c1',
      's1',
      'p1',
    ]);
  });
});
