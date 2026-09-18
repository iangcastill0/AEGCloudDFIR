import { describe, expect, it } from 'vitest';
import { QUERY_CONCURRENCY, QUERY_ID_CHUNK, chunkIds, queryInChunks } from './chunked.js';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${String(i)}`);

describe('chunkIds', () => {
  it('splits at the configured size and keeps every id exactly once', () => {
    const batches = chunkIds(ids(12), 5);
    expect(batches.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(batches.flat()).toHaveLength(12);
    expect(new Set(batches.flat()).size).toBe(12);
  });

  it("stays an order of magnitude under Prisma's 32,767 bind-variable ceiling", () => {
    // Halved again by callers whose query names each id twice.
    expect(QUERY_ID_CHUNK * 2).toBeLessThan(32_767);
  });
});

describe('queryInChunks', () => {
  it('returns every row, in batch order', async () => {
    const rows = await queryInChunks(
      ids(10),
      (batch) => Promise.resolve(batch.map((id) => ({ id }))),
      3,
    );
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id)).toEqual(ids(10));
  });

  it('does nothing for an empty list', async () => {
    let called = 0;
    const rows = await queryInChunks([], () => {
      called += 1;
      return Promise.resolve([]);
    });
    expect(rows).toEqual([]);
    expect(called).toBe(0);
  });

  /**
   * The reason this is bounded at all. A 434,910-item export expands to 174
   * batches; `Promise.all` over all of them opened 174 concurrent queries
   * against a database already at 74% CPU.
   */
  it('never runs more batches at once than the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await queryInChunks(
      ids(500),
      async (batch) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return batch;
      },
      10, // 50 batches
      4,
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // still concurrent, not serialised
  });

  it('defaults to a bounded limit rather than unbounded parallelism', async () => {
    let peak = 0;
    let inFlight = 0;
    await queryInChunks(
      ids(1000),
      async (batch) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return batch;
      },
      10, // 100 batches
    );
    expect(peak).toBeLessThanOrEqual(QUERY_CONCURRENCY);
  });

  it('runs fewer lanes than the limit when there are fewer batches', async () => {
    let peak = 0;
    let inFlight = 0;
    await queryInChunks(
      ids(4),
      async (batch) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return batch;
      },
      2, // 2 batches
      8,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('propagates a failing batch rather than returning partial rows', async () => {
    const run = (batch: string[]): Promise<string[]> =>
      batch.includes('id-15') ? Promise.reject(new Error('boom')) : Promise.resolve(batch);
    await expect(queryInChunks(ids(30), run, 10)).rejects.toThrow('boom');
  });
});
