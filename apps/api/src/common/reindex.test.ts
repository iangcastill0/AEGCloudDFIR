import { describe, expect, it, vi } from 'vitest';
import type { TenantScopedTx } from '@aeg-clouddfir/database';
import { enqueueReindex } from './reindex.js';

const TENANT = '00000000-0000-4000-8000-00000000aaaa';
const ITEM = '00000000-0000-4000-8000-00000000bbbb';

function fakeTx(ids: string[], version = 3) {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const tx = {
    evidenceItem: { findMany: vi.fn(async () => ids.map((id) => ({ id, version }))) },
    outboxEvent: { createMany },
  } as unknown as TenantScopedTx;
  return { tx, createMany };
}

type Row = { topic: string; dedupKey: string; payload: Record<string, unknown> };
function rows(createMany: ReturnType<typeof vi.fn>, call = 0): Row[] {
  return (createMany.mock.calls[call]?.[0] as { data: Row[] }).data;
}

describe('enqueueReindex', () => {
  it('writes one search.index event per item, carrying the current version', async () => {
    const { tx, createMany } = fakeTx([ITEM]);
    const count = await enqueueReindex(tx, TENANT, [ITEM], 'case');
    expect(count).toBe(1);
    const [row] = rows(createMany);
    expect(row?.topic).toBe('search.index');
    expect(row?.payload).toEqual({ tenantId: TENANT, evidenceItemId: ITEM, version: 3 });
  });

  it('gives two calls DIFFERENT dedup keys for the same item at the same version', async () => {
    // This is the whole point. Outbox rows are kept after dispatch and
    // (topic, dedupKey) is unique, so a key built only from item + version is a
    // once-ever key: the second change at that version would be dropped by
    // skipDuplicates and the index would silently keep the old answer.
    const first = fakeTx([ITEM]);
    const second = fakeTx([ITEM]);
    await enqueueReindex(first.tx, TENANT, [ITEM], 'case');
    await enqueueReindex(second.tx, TENANT, [ITEM], 'case');
    expect(rows(first.createMany)[0]?.dedupKey).not.toBe(rows(second.createMany)[0]?.dedupKey);
  });

  it('keeps the item, version and reason visible in the dedup key', async () => {
    const { tx, createMany } = fakeTx([ITEM]);
    await enqueueReindex(tx, TENANT, [ITEM], 'case');
    expect(rows(createMany)[0]?.dedupKey).toMatch(new RegExp(`^index:${ITEM}:v3:case-`));
  });

  it('chunks large batches instead of one giant insert', async () => {
    const ids = Array.from(
      { length: 1200 },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    const { tx, createMany } = fakeTx(ids);
    const count = await enqueueReindex(tx, TENANT, ids, 'case');
    expect(count).toBe(1200);
    expect(createMany).toHaveBeenCalledTimes(3); // 500 + 500 + 200
  });

  it('does nothing when there are no items', async () => {
    const { tx, createMany } = fakeTx([]);
    expect(await enqueueReindex(tx, TENANT, [], 'case')).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
