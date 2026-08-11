import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@evidencevault/database';
import { OutboxDispatcher, type JobEnqueuer, type OutboxRow } from './dispatcher.js';

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface FakeTx {
  $executeRaw: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makePrisma(rows: OutboxRow[]): { prisma: PrismaClient; tx: FakeTx } {
  const tx: FakeTx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(rows),
  };
  const prisma = {
    $transaction: (fn: (tx: FakeTx) => Promise<number>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

const row = (id: string, topic = 'collection.discover'): OutboxRow => ({
  id,
  tenantId: '11111111-1111-4111-8111-111111111111',
  topic,
  dedupKey: `discover:${id}`,
  payload: { collectionId: id },
  attempts: 0,
});

describe('OutboxDispatcher.dispatchOnce', () => {
  it('sets worker RLS context before reading the outbox', async () => {
    const { prisma, tx } = makePrisma([]);
    const enqueuer: JobEnqueuer = { enqueue: vi.fn() };
    await new OutboxDispatcher(prisma, enqueuer, silentLog).dispatchOnce();
    const firstCall = tx.$executeRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(firstCall.join('')).toContain("set_config('app.worker', 'true', true)");
  });

  it('enqueues each pending row with its dedup key and tenant payload', async () => {
    const { prisma } = makePrisma([row('a'), row('b')]);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const handled = await new OutboxDispatcher(prisma, { enqueue }, silentLog).dispatchOnce();
    expect(handled).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(
      'collection.discover',
      'discover:a',
      expect.objectContaining({
        tenantId: '11111111-1111-4111-8111-111111111111',
        collectionId: 'a',
        outboxEventId: 'a',
      }),
    );
  });

  it('marks only successfully enqueued rows dispatched; failures get attempts+1', async () => {
    const { prisma, tx } = makePrisma([row('ok'), row('bad')]);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'));
    await new OutboxDispatcher(prisma, { enqueue }, silentLog).dispatchOnce();

    const sqlCalls = tx.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('¶'));
    const failureUpdate = sqlCalls.find((s) => s.includes('"lastError"'));
    expect(failureUpdate).toBeTruthy();
    const dispatchedUpdate = sqlCalls.find((s) => s.includes('"dispatchedAt"'));
    expect(dispatchedUpdate).toBeTruthy();
    // dispatched update receives only the successful id
    const dispatchedCall = tx.$executeRaw.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).join('').includes('"dispatchedAt"'),
    );
    expect(dispatchedCall?.[1]).toEqual(['ok']);
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it('permanently fails a row that reaches maxAttempts', async () => {
    const exhausted = { ...row('x'), attempts: 9 };
    const { prisma, tx } = makePrisma([exhausted]);
    const enqueue = vi.fn().mockRejectedValue(new Error('still broken'));
    await new OutboxDispatcher(prisma, { enqueue }, silentLog, { maxAttempts: 10 }).dispatchOnce();
    const failCall = tx.$executeRaw.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).join('').includes('"lastError"'),
    );
    // params: attempts, message, status, id
    expect(failCall?.slice(1)).toEqual(expect.arrayContaining([10, 'still broken', 'failed', 'x']));
  });

  it('returns 0 on an empty outbox', async () => {
    const { prisma } = makePrisma([]);
    const enqueue = vi.fn();
    const handled = await new OutboxDispatcher(prisma, { enqueue }, silentLog).dispatchOnce();
    expect(handled).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('run loop', () => {
  it('stops promptly when the abort signal fires', async () => {
    const { prisma } = makePrisma([]);
    const dispatcher = new OutboxDispatcher(prisma, { enqueue: vi.fn() }, silentLog, {
      idleDelayMs: 10,
    });
    const abort = new AbortController();
    const done = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(dispatcher.isRunning).toBe(true);
    abort.abort();
    await done;
    expect(dispatcher.isRunning).toBe(false);
  });
});
