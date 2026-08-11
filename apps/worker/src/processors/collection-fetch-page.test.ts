import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeltaExpiredError } from '@evidencevault/connectors';
import { QUEUES } from '../queues.js';
import {
  COLLECTION,
  CUSTODIAN,
  TENANT,
  createManyRows,
  fakeCtx,
  type FakeCtx,
} from '../testing/fakes.js';
import {
  cursorHash,
  exhaustedCursorKind,
  processCollectionFetchPage,
} from './collection-fetch-page.js';

vi.mock('../connector-factory.js', () => ({
  buildConnectorsForAccount: vi.fn(),
  makeRateLimitObserver: vi.fn(() => () => undefined),
}));
const factory = await import('../connector-factory.js');
const buildConnectors = vi.mocked(factory.buildConnectorsForAccount);

const payload = {
  tenantId: TENANT,
  collectionId: COLLECTION,
  custodianId: CUSTODIAN,
  source: 'email' as const,
  scopeKey: 'folder-1',
};

function arm(f: FakeCtx, checkpoint: Partial<Record<string, unknown>> = {}): void {
  f.tx.collection.findUnique.mockResolvedValue({
    status: 'fetching',
    scope: { dateRange: { kind: 'all_time' } },
    connectorAccountId: '44444444-4444-4444-8444-444444444444',
  });
  f.tx.collectionCheckpoint.findUnique.mockResolvedValue({
    id: 'ckpt-1',
    cursorKind: 'page',
    cursor: '',
    version: 3,
    ...checkpoint,
  });
  f.tx.custodian.findUnique.mockResolvedValue({
    id: CUSTODIAN,
    externalId: 'ext-1',
    email: 'user@example.com',
  });
}

function armConnector(listMessages: ReturnType<typeof vi.fn>): void {
  buildConnectors.mockResolvedValue({
    provider: 'microsoft',
    mode: 'delegated',
    custodianRef: 'me',
    email: { listMessages, listMailFolders: vi.fn(), fetchMessage: vi.fn(), getMailDelta: vi.fn() },
    drive: {
      listDrives: vi.fn(),
      listFiles: vi.fn(),
      fetchContent: vi.fn(),
      getChangesDelta: vi.fn(),
    },
  } as never);
}

describe('processCollectionFetchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates items with skipDuplicates and enqueues fetch-item only for pending items', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(
      vi.fn().mockResolvedValue({
        items: [
          { providerItemId: 'm1', providerImmutableId: 'im1' },
          { providerItemId: 'm2', providerImmutableId: 'im2' },
          { providerItemId: 'm3', providerImmutableId: 'im3' },
        ],
        nextCursor: 'https://next.page',
      }),
    );
    f.tx.collectionItem.createMany.mockResolvedValue({ count: 2 });
    // m3 is already preserved: only m1 (discovered) and m2 (failed, retryable) come back.
    f.tx.collectionItem.findMany.mockResolvedValue([
      { providerItemId: 'm1', attempts: 0 },
      { providerItemId: 'm2', attempts: 2 },
    ]);

    await processCollectionFetchPage(f.ctx, payload);

    const createCall = f.tx.collectionItem.createMany.mock.calls[0]?.[0] as {
      data: unknown[];
      skipDuplicates: boolean;
    };
    expect(createCall.skipDuplicates).toBe(true);
    expect(createCall.data).toHaveLength(3);

    const outbox = createManyRows(f.tx.outboxEvent);
    const fetchItems = outbox.filter((r) => r['topic'] === QUEUES.collectionFetchItem);
    expect(fetchItems).toHaveLength(2);
    expect(fetchItems.map((r) => r['dedupKey'])).toEqual([
      `item:${COLLECTION}:${CUSTODIAN}:email:m1:a0`,
      `item:${COLLECTION}:${CUSTODIAN}:email:m2:a2`,
    ]);
    // next page enqueued because the checkpoint advanced
    const nextPages = outbox.filter((r) => r['topic'] === QUEUES.collectionFetchPage);
    expect(nextPages).toHaveLength(1);
    expect(nextPages[0]?.['dedupKey']).toContain(cursorHash('https://next.page'));
  });

  it('advances the checkpoint with a version guard; a stale version stops continuation', async () => {
    const f = fakeCtx();
    arm(f, { version: 3 });
    armConnector(
      vi.fn().mockResolvedValue({
        items: [{ providerItemId: 'm1' }],
        nextCursor: 'https://next.page',
      }),
    );
    f.tx.collectionItem.createMany.mockResolvedValue({ count: 1 });
    f.tx.collectionItem.findMany.mockResolvedValue([{ providerItemId: 'm1', attempts: 0 }]);
    // Another worker already advanced the checkpoint.
    f.tx.collectionCheckpoint.updateMany.mockResolvedValue({ count: 0 });

    await processCollectionFetchPage(f.ctx, payload);

    const guard = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(guard.where).toEqual({ id: 'ckpt-1', version: 3 });
    const outbox = createManyRows(f.tx.outboxEvent);
    expect(outbox.filter((r) => r['topic'] === QUEUES.collectionFetchPage)).toHaveLength(0);
    expect(outbox.filter((r) => r['topic'] === QUEUES.collectionFinalize)).toHaveLength(0);
  });

  it('marks the scope exhausted and schedules a finalize check when no next cursor', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(vi.fn().mockResolvedValue({ items: [], deltaCursor: 'delta-token' }));

    await processCollectionFetchPage(f.ctx, payload);

    const advance = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(advance.data['cursorKind']).toBe('delta');
    expect(advance.data['cursor']).toBe('delta-token');
    const outbox = createManyRows(f.tx.outboxEvent);
    const finalize = outbox.filter((r) => r['topic'] === QUEUES.collectionFinalize);
    expect(finalize).toHaveLength(1);
    expect(finalize[0]?.['dedupKey']).toBe(`finalize:${COLLECTION}:chk:folder-1`);
  });

  it('delta expiry resets the checkpoint, records an exception, and starts reconciliation', async () => {
    const f = fakeCtx();
    arm(f, { cursorKind: 'delta', cursor: 'expired-delta', version: 9 });
    const getMailDelta = vi.fn().mockRejectedValue(new DeltaExpiredError('delta expired'));
    buildConnectors.mockResolvedValue({
      provider: 'microsoft',
      mode: 'delegated',
      custodianRef: 'me',
      email: {
        listMessages: vi.fn(),
        listMailFolders: vi.fn(),
        fetchMessage: vi.fn(),
        getMailDelta,
      },
      drive: {
        listDrives: vi.fn(),
        listFiles: vi.fn(),
        fetchContent: vi.fn(),
        getChangesDelta: vi.fn(),
      },
    } as never);

    await processCollectionFetchPage(f.ctx, payload);

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'expired_checkpoint' }),
      }),
    );
    const reset = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(reset.where).toEqual({ id: 'ckpt-1', version: 9 });
    expect(reset.data).toEqual({ cursor: '', cursorKind: 'page', version: 10 });
    const outbox = createManyRows(f.tx.outboxEvent);
    expect(outbox[0]?.['dedupKey']).toContain(':rescan:10');
    const audit = f.tx.auditEvent.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('collection.reconciliation_started');
  });

  it('bails quietly when the collection is not fetching', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.collection.findUnique.mockResolvedValue({
      status: 'paused',
      scope: { dateRange: { kind: 'all_time' } },
      connectorAccountId: '44444444-4444-4444-8444-444444444444',
    });
    await processCollectionFetchPage(f.ctx, payload);
    expect(buildConnectors).not.toHaveBeenCalled();
  });
});

describe('exhaustedCursorKind', () => {
  it('maps provider/source pairs and empty delta cursors honestly', () => {
    expect(exhaustedCursorKind('microsoft', 'email', 'x')).toBe('delta');
    expect(exhaustedCursorKind('google', 'email', 'x')).toBe('history');
    expect(exhaustedCursorKind('google', 'drive', 'x')).toBe('changes');
    expect(exhaustedCursorKind('microsoft', 'drive', 'x')).toBe('delta');
    expect(exhaustedCursorKind('google', 'email', undefined)).toBe('none');
  });
});
