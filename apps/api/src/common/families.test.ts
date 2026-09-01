import { describe, expect, it, vi } from 'vitest';
import { FAMILY_QUERY_CHUNK, chunk, expandDescendants, expandFamilies } from './families.js';
import type { TenantScopedTx } from '@aeg-clouddfir/database';

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
 * PostgreSQL's wire protocol carries the bind-parameter count in an int16, so a
 * single statement can take at most 65,535 of them.
 *
 * Found on staging: a production with inverted selection and includeFamilies
 * passed 50,000 ids into one query built as
 * `OR: [{parentId: {in: ids}}, {childId: {in: ids}}]` — 100,000 parameters. It
 * failed in 618ms with a bare HTTP 500 and nothing in the log.
 */
describe('expandFamilies stays under the bind-parameter limit', () => {
  const PG_BIND_LIMIT = 65_535;

  it('never sends more parameters than PostgreSQL accepts', async () => {
    const { tx, bindCounts } = recordingTx();
    await expandFamilies(tx, 'tenant', ids(50_000));
    expect(bindCounts.length).toBeGreaterThan(1);
    for (const count of bindCounts) {
      expect(count).toBeLessThan(PG_BIND_LIMIT);
    }
  });

  it('counts BOTH sides of the OR, which is what doubled the real query', async () => {
    // A chunk of N ids appears twice — once for parentId, once for childId — so
    // the safe chunk size is half what a single-column query could take.
    const { tx, bindCounts } = recordingTx();
    await expandFamilies(tx, 'tenant', ids(FAMILY_QUERY_CHUNK));
    expect(bindCounts[0]).toBe(FAMILY_QUERY_CHUNK * 2 + 2);
  });

  it('returns every family member found across all chunks', async () => {
    const { tx } = recordingTx([{ parentId: 'parent-x', childId: 'child-y' }]);
    const result = await expandFamilies(tx, 'tenant', ids(12_000));
    expect(result).toContain('parent-x');
    expect(result).toContain('child-y');
    expect(result).toContain('id-0');
    expect(result).toContain('id-11999');
  });

  it('de-duplicates rather than returning an id once per chunk', async () => {
    const { tx } = recordingTx([{ parentId: 'shared', childId: 'shared' }]);
    const result = await expandFamilies(tx, 'tenant', ids(12_000));
    expect(result.filter((id) => id === 'shared')).toHaveLength(1);
    expect(new Set(result).size).toBe(result.length);
  });

  it('still does one query for a small selection', async () => {
    const { tx, findMany } = recordingTx();
    await expandFamilies(tx, 'tenant', ids(3));
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an empty selection', async () => {
    const { tx, findMany } = recordingTx();
    expect(await expandFamilies(tx, 'tenant', [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('expandDescendants has the same limit', () => {
  it('chunks a large selection', async () => {
    const { tx, bindCounts } = recordingTx();
    await expandDescendants(tx, 'tenant', ids(50_000));
    expect(bindCounts.length).toBeGreaterThan(1);
    for (const count of bindCounts) expect(count).toBeLessThan(65_535);
  });

  it('returns the children it found', async () => {
    const { tx } = recordingTx([{ parentId: 'p', childId: 'kid' }]);
    const result = await expandDescendants(tx, 'tenant', ids(12_000));
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
