import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderApiError } from '@evidencevault/connectors';
import { QUEUES } from '../queues.js';
import {
  COLLECTION,
  CUSTODIAN,
  TENANT,
  createManyRows,
  fakeCtx,
  type FakeCtx,
} from '../testing/fakes.js';
import { processAuditFetchPage } from './collection-audit-fetch-page.js';

vi.mock('../connector-factory.js', () => ({
  buildAuditConnectors: vi.fn(),
  makeRateLimitObserver: vi.fn(() => () => undefined),
}));
const factory = await import('../connector-factory.js');
const buildAuditConnectors = vi.mocked(factory.buildAuditConnectors);

const SCOPE_KEY = 'o365_management_activity::Audit.Exchange';

const payload = {
  tenantId: TENANT,
  collectionId: COLLECTION,
  custodianId: CUSTODIAN,
  source: 'audit' as const,
  scopeKey: SCOPE_KEY,
};

function arm(f: FakeCtx, checkpoint: Partial<Record<string, unknown>> = {}): void {
  f.tx.collection.findUnique.mockResolvedValue({
    status: 'fetching',
    scope: {
      dateRange: { kind: 'all_time' },
      audit: {
        microsoft: {
          managementContentTypes: ['Audit.Exchange'],
          includeGraphSignins: false,
          includeGraphDirectoryAudits: false,
        },
        actorFilter: [],
      },
    },
    connectorAccountId: '44444444-4444-4444-8444-444444444444',
  });
  f.tx.collectionCheckpoint.findUnique.mockResolvedValue({
    id: 'ckpt-audit',
    cursorKind: 'page',
    cursor: '',
    version: 2,
    ...checkpoint,
  });
  f.tx.connectorAccount.findUnique.mockResolvedValue({ provider: 'microsoft' });
}

function armConnector(fetchAuditPage: ReturnType<typeof vi.fn>): void {
  buildAuditConnectors.mockResolvedValue({
    provider: 'microsoft',
    mode: 'organization',
    connectors: [
      {
        kind: 'o365_management_activity',
        connector: { listAuditScopes: vi.fn(), fetchAuditPage },
      },
    ],
  } as never);
}

function sampleBatch(overrides: Record<string, unknown> = {}) {
  return {
    system: 'o365_management_activity',
    batchId: 'b1',
    scopeKey: 'Audit.Exchange',
    rawBytes: new Uint8Array([1, 2, 3]),
    contentType: 'application/json',
    records: [
      {
        system: 'o365_management_activity',
        providerRecordId: 'r1',
        workload: 'Exchange',
        operation: 'MailItemsAccessed',
        actorEmail: 'alice@example.com',
        occurredAt: '2026-01-01T00:00:00Z',
        raw: { Id: 'r1' },
      },
    ],
    providerReportedCount: 1,
    ...overrides,
  };
}

describe('processAuditFetchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stages a batch, inserts audit records with skipDuplicates, and indexes it', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(vi.fn().mockResolvedValue({ batches: [sampleBatch()], nextCursor: undefined }));
    f.tx.collectionItem.createMany.mockResolvedValue({ count: 1 });
    f.tx.evidenceBlob.findUniqueOrThrow.mockResolvedValue({ id: 'blob-1' });
    f.tx.evidenceItem.create.mockResolvedValue({ id: 'ev-audit-1' });

    await processAuditFetchPage(f.ctx, payload);

    // Raw batch bytes preserved via the object store.
    expect(f.store.stageStream).toHaveBeenCalledTimes(1);
    expect(f.store.promoteToOriginal).toHaveBeenCalledTimes(1);

    // Evidence item is an audit_batch.
    const evCreate = f.tx.evidenceItem.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(evCreate.data['kind']).toBe('audit_batch');
    expect(evCreate.data['mimeType']).toBe('application/json');
    expect(evCreate.data['name']).toBe('o365_management_activity/Audit.Exchange/b1.json');

    // Audit records inserted idempotently.
    const arCreate = f.tx.auditRecord.createMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(arCreate.skipDuplicates).toBe(true);
    expect(arCreate.data).toHaveLength(1);
    expect(arCreate.data[0]?.['providerRecordId']).toBe('r1');
    expect(arCreate.data[0]?.['operation']).toBe('MailItemsAccessed');

    // Search index enqueued at the batch level with the audit stage.
    const outbox = createManyRows(f.tx.outboxEvent);
    const index = outbox.filter((r) => r['topic'] === QUEUES.searchIndex);
    expect(index).toHaveLength(1);
    expect(index[0]?.['dedupKey']).toContain(':audit');

    // Scope exhausted (no next cursor) => checkpoint 'none' + finalize check.
    const advance = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(advance.where).toEqual({ id: 'ckpt-audit', version: 2 });
    expect(advance.data['cursorKind']).toBe('none');
    expect(outbox.filter((r) => r['topic'] === QUEUES.collectionFinalize)).toHaveLength(1);
  });

  it('enqueues the next page when the provider returns a cursor', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(vi.fn().mockResolvedValue({ batches: [sampleBatch()], nextCursor: 'opaque-2' }));
    f.tx.collectionItem.createMany.mockResolvedValue({ count: 1 });
    f.tx.evidenceBlob.findUniqueOrThrow.mockResolvedValue({ id: 'blob-1' });
    f.tx.evidenceItem.create.mockResolvedValue({ id: 'ev-audit-1' });

    await processAuditFetchPage(f.ctx, payload);

    const advance = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(advance.data['cursor']).toBe('opaque-2');
    expect(advance.data['cursorKind']).toBe('page');
    const outbox = createManyRows(f.tx.outboxEvent);
    expect(outbox.filter((r) => r['topic'] === QUEUES.collectionFetchPage)).toHaveLength(1);
  });

  it('does not write evidence when the checkpoint version is stale', async () => {
    const f = fakeCtx();
    arm(f, { version: 5 });
    armConnector(vi.fn().mockResolvedValue({ batches: [sampleBatch()], nextCursor: undefined }));
    // Another worker already advanced the checkpoint.
    f.tx.collectionCheckpoint.updateMany.mockResolvedValue({ count: 0 });

    await processAuditFetchPage(f.ctx, payload);

    expect(f.tx.evidenceItem.create).not.toHaveBeenCalled();
    expect(f.tx.auditRecord.createMany).not.toHaveBeenCalled();
  });

  it('skips a batch already persisted by a prior run (dedup spine)', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(vi.fn().mockResolvedValue({ batches: [sampleBatch()], nextCursor: undefined }));
    // collectionItem already exists -> createMany inserts nothing.
    f.tx.collectionItem.createMany.mockResolvedValue({ count: 0 });

    await processAuditFetchPage(f.ctx, payload);

    expect(f.tx.evidenceItem.create).not.toHaveBeenCalled();
  });

  it('treats a per-scope 403 as a permission exception, not a hard failure', async () => {
    const f = fakeCtx();
    arm(f);
    armConnector(vi.fn().mockRejectedValue(new ProviderApiError('forbidden', { status: 403 })));

    await processAuditFetchPage(f.ctx, payload);

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'permission_denied' }),
      }),
    );
    // Checkpoint exhausted so the collection can still finalize.
    const reset = f.tx.collectionCheckpoint.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(reset.data['cursorKind']).toBe('none');
    const outbox = createManyRows(f.tx.outboxEvent);
    expect(outbox.filter((r) => r['topic'] === QUEUES.collectionFinalize)).toHaveLength(1);
    expect(f.tx.evidenceItem.create).not.toHaveBeenCalled();
  });

  it('bails quietly when the collection is not fetching', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.collection.findUnique.mockResolvedValue({
      status: 'paused',
      scope: { dateRange: { kind: 'all_time' } },
      connectorAccountId: '44444444-4444-4444-8444-444444444444',
    });

    await processAuditFetchPage(f.ctx, payload);
    expect(buildAuditConnectors).not.toHaveBeenCalled();
  });
});
