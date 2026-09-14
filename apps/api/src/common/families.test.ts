import { describe, expect, it, vi } from 'vitest';
import {
  chunk,
  expandDescendants,
  expandFamilies,
  FAMILY_QUERY_CHUNK,
  onTx,
  queryInChunks,
} from './families.js';
import { FAMILY_RELATIONSHIP_KINDS, type TenantScopedTx } from '@aeg-clouddfir/database';

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `id-${String(i)}`);
}

/** Records the size of every `in` array each query sends. */
function recordingTx(rows: { parentId: string; childId: string }[] = []) {
  const bindCounts: number[] = [];
  const findMany = vi.fn((args: { where: Record<string, unknown> }) => {
    let count = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === 'in' && Array.isArray(value)) count += value.length;
          else walk(value);
        }
      }
    };
    walk(args.where);
    bindCounts.push(count);
    return Promise.resolve(rows);
  });
  return {
    tx: { evidenceRelationship: { findMany } } as unknown as TenantScopedTx,
    bindCounts,
    findMany,
  };
}

/**
 * Prisma refuses a statement carrying more than 32,767 bind variables — half
 * PostgreSQL's own 65,535, which is why sizing against the bigger number still
 * breaks.
 *
 * Found on staging: a production with inverted selection and includeFamilies
 * passed 50,000 ids into one query built as
 * `OR: [{parentId: {in: ids}}, {childId: {in: ids}}]` — 100,000 parameters. It
 * failed in 618ms with a bare HTTP 500 and nothing in the log.
 */
describe('expandFamilies stays under the bind-parameter limit', () => {
  const PRISMA_BIND_LIMIT = 32_767;

  it('never sends more parameters than Prisma accepts', async () => {
    const { tx, bindCounts } = recordingTx();
    await expandFamilies(onTx(tx), 'tenant', ids(50_000));
    expect(bindCounts.length).toBeGreaterThan(1);
    for (const count of bindCounts) {
      expect(count).toBeLessThan(PRISMA_BIND_LIMIT);
    }
  });

  it('counts BOTH sides of the OR, which is what doubled the real query', async () => {
    // A chunk of N ids appears twice — once for parentId, once for childId — so
    // the safe chunk size is half what a single-column query could take.
    // Derived, not hardcoded: the kind list is shared now, and a hardcoded
    // count made this fail the moment inline_attachment was added to it.
    const { tx, bindCounts } = recordingTx();
    await expandFamilies(onTx(tx), 'tenant', ids(FAMILY_QUERY_CHUNK));
    const perQuery = FAMILY_QUERY_CHUNK * 2 + FAMILY_RELATIONSHIP_KINDS.length;
    expect(bindCounts[0]).toBe(perQuery);
  });

  it('returns every family member found across all chunks', async () => {
    const { tx } = recordingTx([{ parentId: 'parent-x', childId: 'child-y' }]);
    const result = await expandFamilies(onTx(tx), 'tenant', ids(12_000));
    expect(result).toContain('parent-x');
    expect(result).toContain('child-y');
    expect(result).toContain('id-0');
    expect(result).toContain('id-11999');
  });

  it('de-duplicates rather than returning an id once per chunk', async () => {
    const { tx } = recordingTx([{ parentId: 'shared', childId: 'shared' }]);
    const result = await expandFamilies(onTx(tx), 'tenant', ids(12_000));
    expect(result.filter((id) => id === 'shared')).toHaveLength(1);
    expect(new Set(result).size).toBe(result.length);
  });

  it('still does one query for a small selection', async () => {
    const { tx, findMany } = recordingTx();
    await expandFamilies(onTx(tx), 'tenant', ids(3));
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an empty selection', async () => {
    const { tx, findMany } = recordingTx();
    expect(await expandFamilies(onTx(tx), 'tenant', [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('expandDescendants has the same limit', () => {
  it('chunks a large selection', async () => {
    const { tx, bindCounts } = recordingTx();
    await expandDescendants(onTx(tx), 'tenant', ids(50_000));
    expect(bindCounts.length).toBeGreaterThan(1);
    for (const count of bindCounts) expect(count).toBeLessThan(65_535);
  });

  it('returns the children it found', async () => {
    const { tx } = recordingTx([{ parentId: 'p', childId: 'kid' }]);
    const result = await expandDescendants(onTx(tx), 'tenant', ids(12_000));
    expect(result).toContain('kid');
  });
});

describe('chunk', () => {
  it('splits evenly and keeps the remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('queryInChunks', () => {
  /**
   * The rule this enforces: nothing bounds how much a collection acquires, so
   * nothing bounds a case, export or production built from one. Prisma refuses
   * a statement with more than 32,767 bind variables, and an id list IS the
   * bind variables.
   */
  const uuids = (n: number): string[] =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    );

  it('never sends a batch near the bind-variable ceiling', async () => {
    const sizes: number[] = [];
    await queryInChunks(uuids(43_379), async (batch) => {
      sizes.push(batch.length);
      return batch;
    });
    expect(Math.max(...sizes)).toBeLessThan(32_767);
  });

  it('returns every row — chunking must never lose one', async () => {
    const rows = await queryInChunks(uuids(43_379), async (batch) => batch);
    expect(rows).toHaveLength(43_379);
    expect(new Set(rows).size).toBe(43_379);
  });

  it('runs no query at all for an empty list', async () => {
    const run = vi.fn(async (batch: string[]) => batch);
    expect(await queryInChunks([], run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('honours a smaller batch size for queries that name each id twice', async () => {
    // expandFamilies matches on parentId OR childId, so each id costs two
    // parameters and the safe batch is half the usual one.
    const sizes: number[] = [];
    await queryInChunks(
      uuids(20_000),
      async (batch) => {
        sizes.push(batch.length);
        return batch;
      },
      2_500,
    );
    expect(Math.max(...sizes)).toBe(2_500);
  });
});
