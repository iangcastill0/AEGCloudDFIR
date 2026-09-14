import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_PAGE_SIZE,
  MANIFEST_ROW_CAP,
  ManifestTooLargeError,
  loadManifestItems,
  toManifestItem,
  type ManifestItemRow,
} from './manifest-items.js';

function row(i: number, over: Partial<ManifestItemRow> = {}): ManifestItemRow {
  return {
    id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    providerItemId: `msg-${String(i)}`,
    custodianId: 'cust-1',
    sha256: 'a'.repeat(64),
    size: 1234,
    acquiredAt: new Date('2026-09-10T19:43:00.000Z'),
    isApiExportDerivative: false,
    blob: { objectKey: `tenants/t/originals/${String(i)}` },
    ...over,
  };
}

/**
 * A fake table of `total` rows, served a page at a time by cursor.
 *
 * The cursor lookup is a Map, not findIndex. A linear scan per page is O(n*n)
 * across the walk — at 185,119 rows over 93 pages that is ~17 million string
 * comparisons, which took 9 seconds on CI and timed the test out. The fake was
 * slow, not the code under test.
 */
function pagedSource(total: number, over: (i: number) => Partial<ManifestItemRow> = () => ({})) {
  const all = Array.from({ length: total }, (_, i) => row(i, over(i)));
  const indexById = new Map(all.map((r, i) => [r.id, i]));
  const read = vi.fn((cursor: string | undefined, take: number) => {
    const start = cursor === undefined ? 0 : (indexById.get(cursor) ?? -1) + 1;
    return Promise.resolve(all.slice(start, start + take));
  });
  return { read, all };
}

describe('loadManifestItems', () => {
  /**
   * The bug: finalize loaded every evidence item in ONE transaction. On a real
   * collection of 434,910 evidence items that took 44-72 seconds against a
   * 30-second limit, so it retried every 30 seconds and could never seal. It
   * also held every row in memory at once — 5.2 GiB for one manifest.
   */
  it('returns every item across many pages', async () => {
    // 100,000 is 50 pages. The real matter held 434,910 evidence items; the
    // walk is the same shape at either size, and a test near the timeout is a
    // test that flakes.
    const { read } = pagedSource(100_000);
    const items = await loadManifestItems(read);
    expect(items).toHaveLength(100_000);
    // Nothing duplicated or dropped by the cursor walk.
    expect(new Set(items.map((i) => i.evidenceItemId)).size).toBe(100_000);
  }, 20_000);

  it('never asks for more than one page at a time', async () => {
    // The whole point: no single query big enough to blow the transaction
    // limit, however large the collection.
    const { read } = pagedSource(50_000);
    await loadManifestItems(read);
    for (const call of read.mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(MANIFEST_PAGE_SIZE);
    }
  });

  it('pages with a cursor rather than an offset', async () => {
    // OFFSET makes the database walk every skipped row, so the last page of a
    // 434,910-item collection would be the slowest — the opposite of what is
    // needed here.
    const { read, all } = pagedSource(5_000);
    await loadManifestItems(read, 1_000);
    expect(read.mock.calls[0]?.[0]).toBeUndefined();
    expect(read.mock.calls[1]?.[0]).toBe(all[999]?.id);
    expect(read.mock.calls[2]?.[0]).toBe(all[1_999]?.id);
  });

  it('stops on a short page instead of making one pointless extra query', async () => {
    const { read } = pagedSource(1_500);
    await loadManifestItems(read, 1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops cleanly on an exactly-full final page', async () => {
    // 2,000 rows at a page size of 1,000 means the second page is full; the
    // third must come back empty and end it without looping.
    const { read } = pagedSource(2_000);
    const items = await loadManifestItems(read, 1_000);
    expect(items).toHaveLength(2_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('handles an empty collection', async () => {
    const { read } = pagedSource(0);
    expect(await loadManifestItems(read)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('leaves out items with no sha256, as before', async () => {
    // An entry with no hash proves nothing, and a manifest is a statement
    // about bytes that were verified.
    const { read } = pagedSource(10, (i) => (i < 3 ? { sha256: '' } : {}));
    const items = await loadManifestItems(read, 5);
    expect(items).toHaveLength(7);
  });

  it('does not lose the page that a filtered item was on', async () => {
    // Filtering happens after paging; a page of entirely unhashed rows must
    // still advance the cursor rather than ending the walk.
    const { read } = pagedSource(10, (i) => (i < 5 ? { sha256: '' } : {}));
    const items = await loadManifestItems(read, 5);
    expect(items).toHaveLength(5);
  });
});

describe('loadManifestItems stops rather than spinning', () => {
  /**
   * The loop ends when a page comes back short or empty, which depends on the
   * cursor advancing every time. Prisma always advances it — but this runs in
   * the worker, and a worker that spins forever in silence is worse than one
   * that stops and says why.
   */
  /** A source that ignores the cursor and always returns a full page. */
  const stuck = () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    return vi.fn(() => Promise.resolve(full));
  };

  it('throws instead of looping when the cursor never advances', async () => {
    // The cap is injected so the guard is proved in a handful of iterations
    // rather than walking five million rows to reach it.
    await expect(loadManifestItems(stuck(), 100, 500)).rejects.toBeInstanceOf(
      ManifestTooLargeError,
    );
  });

  it('says plainly that no manifest was written', async () => {
    // The operator needs to know the collection was NOT sealed, not merely
    // that something went wrong.
    const err = await loadManifestItems(stuck(), 100, 500).catch((e: unknown) => e as Error);
    expect(err.message).toContain('No manifest was written');
    expect(err.message).toContain('500');
  });

  it('defaults to a cap a real collection never reaches', async () => {
    // 434,910 items is the largest seen. The default must stay far above it so
    // a legitimate collection can never trip this.
    expect(MANIFEST_ROW_CAP).toBeGreaterThan(434_910 * 10);
  });
});

describe('toManifestItem', () => {
  it('maps the columns the manifest records', () => {
    expect(toManifestItem(row(1))).toEqual({
      evidenceItemId: '00000000-0000-4000-8000-000000000001',
      providerItemId: 'msg-1',
      custodianId: 'cust-1',
      sha256: 'a'.repeat(64),
      size: 1234,
      objectKey: 'tenants/t/originals/1',
      acquiredAt: '2026-09-10T19:43:00.000Z',
    });
  });

  it('converts a bigint size, which is how Prisma returns it', () => {
    // Number(bigint) — a raw bigint fails manifest validation and cannot be
    // JSON-serialized at all.
    const item = toManifestItem(row(1, { size: 9_007_199_254n }));
    expect(item.size).toBe(9_007_199_254);
    expect(typeof item.size).toBe('number');
  });

  it('records an API-export derivative, and omits the flag otherwise', () => {
    expect(toManifestItem(row(1, { isApiExportDerivative: true })).apiExportDerivative).toBe(true);
    expect(toManifestItem(row(1))).not.toHaveProperty('apiExportDerivative');
  });

  it('tolerates a missing blob or custodian rather than throwing', () => {
    const item = toManifestItem(row(1, { blob: null, custodianId: null }));
    expect(item.objectKey).toBe('');
    expect(item.custodianId).toBe('');
  });
});
