import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES, dedupKeys } from '../queues.js';
import {
  COLLECTION,
  CUSTODIAN,
  EVIDENCE,
  TENANT,
  createManyRows,
  fakeCtx,
  type FakeCtx,
} from '../testing/fakes.js';
import { processCollectionDiscover } from './collection-discover.js';

vi.mock('../connector-factory.js', () => ({
  // Mirror of requireDrive for the other direction: a files-only connector has
  // no mailbox, and must throw rather than quietly collect nothing.
  requireEmail: vi.fn((bundle: { email: unknown; provider: string }) => {
    if (bundle.email === null) {
      throw new Error(`${bundle.provider} connectors collect files only`);
    }
    return bundle.email;
  }),
  buildConnectorsForAccount: vi.fn(),
  buildAuditConnectors: vi.fn(),
  makeRateLimitObserver: vi.fn(() => () => undefined),
}));
const factory = await import('../connector-factory.js');
const buildConnectorsForAccount = vi.mocked(factory.buildConnectorsForAccount);

const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const payload = { tenantId: TENANT, collectionId: COLLECTION };

function armUploadCollection(f: FakeCtx): void {
  f.tx.collection.findUnique.mockResolvedValue({
    status: 'created',
    startedAt: null,
    sources: ['email'],
    connectorAccountId: ACCOUNT,
    connectorAccount: { provider: 'upload' },
    scope: {
      dateRange: { kind: 'all_time' },
      uploads: { evidenceItemIds: [EVIDENCE] },
    },
    custodians: [
      {
        custodianId: CUSTODIAN,
        custodian: { id: CUSTODIAN, externalId: 'jane@example.com', email: 'jane@example.com' },
      },
    ],
  });
}

describe('processCollectionDiscover (upload provider)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims each container, marks it preserved, and schedules pst.extract — no provider clients', async () => {
    const f = fakeCtx();
    armUploadCollection(f);
    f.tx.evidenceItem.findUnique.mockResolvedValue({
      id: EVIDENCE,
      kind: 'container',
      provider: 'upload',
      collectionId: null,
    });
    f.tx.collectionCustodian.findUnique.mockResolvedValue({ id: 'cc-1', progress: {} });

    await processCollectionDiscover(f.ctx, payload);

    // Uploaded containers are local: provider connectors are NEVER built.
    expect(buildConnectorsForAccount).not.toHaveBeenCalled();

    // The container is claimed into the collection for this custodian.
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: EVIDENCE },
        data: { collectionId: COLLECTION, custodianId: CUSTODIAN },
      }),
    );

    // Already preserved (uploaded + content-addressed): item starts preserved.
    const itemData = (
      f.tx.collectionItem.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(itemData).toMatchObject({
      source: 'email',
      providerItemId: `pst:${EVIDENCE}`,
      state: 'preserved',
      evidenceItemId: EVIDENCE,
    });

    const outboxRows = createManyRows(f.tx.outboxEvent);
    const extractRow = outboxRows.find((r) => r.topic === QUEUES.pstExtract);
    expect(extractRow?.dedupKey).toBe(dedupKeys.pstExtract(COLLECTION, EVIDENCE));
    expect(extractRow?.payload).toEqual({
      tenantId: TENANT,
      collectionId: COLLECTION,
      custodianId: CUSTODIAN,
      evidenceItemId: EVIDENCE,
    });

    // No page checkpoints for uploads; collection moves straight to fetching.
    expect(f.tx.collectionCheckpoint.upsert).not.toHaveBeenCalled();
    expect(f.tx.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'fetching' } }),
    );
  });

  it('re-discovery is idempotent: existing items are not re-counted', async () => {
    const f = fakeCtx();
    armUploadCollection(f);
    f.tx.evidenceItem.findUnique.mockResolvedValue({
      id: EVIDENCE,
      kind: 'container',
      provider: 'upload',
      collectionId: COLLECTION, // already claimed by THIS collection
    });
    f.tx.collectionItem.findUnique.mockResolvedValue({ id: 'ci-existing' });

    await processCollectionDiscover(f.ctx, payload);

    expect(f.tx.collectionItem.create).not.toHaveBeenCalled();
    expect(f.tx.collectionCustodian.update).not.toHaveBeenCalled(); // no progress double-count
    const topics = createManyRows(f.tx.outboxEvent).map((r) => r.topic);
    expect(topics).toContain(QUEUES.pstExtract); // job row is dedup-keyed anyway
  });

  it('missing containers become unavailable_item exceptions and an empty claim set fails the collection', async () => {
    const f = fakeCtx();
    armUploadCollection(f);
    f.tx.evidenceItem.findUnique.mockResolvedValue(null);

    await processCollectionDiscover(f.ctx, payload);

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'unavailable_item' }),
      }),
    );
    expect(f.tx.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
