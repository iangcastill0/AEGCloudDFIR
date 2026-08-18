import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CollectionStatus, ConnectorStatus, TenantRole } from '@aeg-clouddfir/database';
import { CollectionsService } from './collections.service.js';
import {
  CONNECTOR_ID,
  ITEM_A,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.case_manager]);
const COLLECTION_ID = '77777777-7777-4777-8777-777777777777';
const CUSTODIAN_ID = '88888888-8888-4888-8888-888888888888';

const createBody = {
  idempotencyKey: 'idem-key-collections-1',
  connectorAccountId: CONNECTOR_ID,
  name: 'Q3 collection',
  kind: 'snapshot',
  sources: ['email'],
  custodianIds: [CUSTODIAN_ID],
  scope: { dateRange: { kind: 'all_time' } },
};

function makeService(models: Record<string, unknown>, opts?: { store?: unknown }) {
  const audit = fakeAudit();
  const prisma = fakePrisma(models);
  const service = new CollectionsService(
    prisma,
    audit.service,
    (opts?.store ?? {
      presignGet: vi.fn(async (_t: string, key: string) => `https://signed/${key}`),
    }) as never,
    testConfig(),
  );
  return { service, prisma, audit };
}

describe('CollectionsService.create', () => {
  it('creates collection + custodians + outbox + audit inside ONE transaction', async () => {
    const collectionCreate = vi.fn(async () => ({
      id: COLLECTION_ID,
      status: CollectionStatus.created,
    }));
    const custodiansCreateMany = vi.fn(async () => ({ count: 1 }));
    const outboxCreate = vi.fn(async () => ({}));
    const { service, prisma, audit } = makeService({
      collection: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: collectionCreate,
      },
      connectorAccount: {
        findFirst: vi.fn(async () => ({
          id: CONNECTOR_ID,
          status: ConnectorStatus.connected,
        })),
      },
      custodian: { findMany: vi.fn(async () => [{ id: CUSTODIAN_ID }]) },
      tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
      collectionCustodian: { createMany: custodiansCreateMany },
      outboxEvent: { create: outboxCreate },
    });

    const result = await service.create(auth, createBody, fakeRequest());
    expect(result).toEqual({ id: COLLECTION_ID, status: 'created', replayed: false });

    // Exactly one transaction bundles the whole logical operation.
    const txMock = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(collectionCreate).toHaveBeenCalledTimes(1);
    expect(custodiansCreateMany).toHaveBeenCalledTimes(1);

    // Worker payload contract: tenantId travels in the payload.
    const outboxArgs = outboxCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(outboxArgs.data.topic).toBe('collection.discover');
    expect(outboxArgs.data.dedupKey).toBe(`discover:${COLLECTION_ID}`);
    expect(outboxArgs.data.payload).toEqual({ tenantId: TENANT_ID, collectionId: COLLECTION_ID });

    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'collection.created', targetId: COLLECTION_ID }),
    );
  });

  it('replays idempotently: an existing idempotencyKey returns the original collection', async () => {
    const collectionCreate = vi.fn();
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.fetching })),
        create: collectionCreate,
      },
    });
    const result = await service.create(auth, createBody, fakeRequest());
    expect(result).toEqual({ id: COLLECTION_ID, status: 'fetching', replayed: true });
    expect(collectionCreate).not.toHaveBeenCalled();
  });

  it('rejects custodians that do not belong to the connector', async () => {
    const { service } = makeService({
      collection: { findFirst: vi.fn(async () => null) },
      connectorAccount: {
        findFirst: vi.fn(async () => ({ id: CONNECTOR_ID, status: ConnectorStatus.connected })),
      },
      custodian: { findMany: vi.fn(async () => []) },
    });
    await expect(service.create(auth, createBody, fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an audit source on a delegated connector with 409', async () => {
    const { service } = makeService({
      collection: { findFirst: vi.fn(async () => null) },
      connectorAccount: {
        findFirst: vi.fn(async () => ({
          id: CONNECTOR_ID,
          status: ConnectorStatus.connected,
          mode: 'delegated',
        })),
      },
    });
    const body = {
      ...createBody,
      idempotencyKey: 'idem-audit-delegated-1',
      sources: ['audit'],
      custodianIds: [],
      scope: {
        dateRange: { kind: 'all_time' },
        audit: { microsoft: { managementContentTypes: ['Audit.Exchange'] } },
      },
    };
    await expect(service.create(auth, body, fakeRequest())).rejects.toThrow(ConflictException);
  });

  it('allows an audit-only collection with no custodians on an org connector', async () => {
    const collectionCreate = vi.fn(async () => ({
      id: COLLECTION_ID,
      status: CollectionStatus.created,
    }));
    const custodiansCreateMany = vi.fn(async () => ({ count: 0 }));
    const outboxCreate = vi.fn(async () => ({}));
    const custodianFindMany = vi.fn(async () => []);
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: collectionCreate,
      },
      connectorAccount: {
        findFirst: vi.fn(async () => ({
          id: CONNECTOR_ID,
          status: ConnectorStatus.connected,
          mode: 'organization',
        })),
      },
      custodian: { findMany: custodianFindMany },
      tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
      collectionCustodian: { createMany: custodiansCreateMany },
      outboxEvent: { create: outboxCreate },
    });

    const body = {
      ...createBody,
      idempotencyKey: 'idem-audit-only-1',
      sources: ['audit'],
      custodianIds: [],
      scope: {
        dateRange: { kind: 'all_time' },
        audit: { google: { reportApplications: ['login'], includeVault: false } },
      },
    };
    const result = await service.create(auth, body, fakeRequest());
    expect(result).toEqual({ id: COLLECTION_ID, status: 'created', replayed: false });
    // No custodian belong-to-connector lookup and no custodian rows created.
    expect(custodianFindMany).not.toHaveBeenCalled();
    expect(custodiansCreateMany).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects an email collection with no custodians (contract relaxation is audit-only)', async () => {
    const { service } = makeService({
      collection: { findFirst: vi.fn(async () => null) },
    });
    const body = { ...createBody, idempotencyKey: 'idem-email-nocust-1', custodianIds: [] };
    await expect(service.create(auth, body, fakeRequest())).rejects.toThrow();
  });
});

describe('CollectionsService.create (uploads)', () => {
  const UPLOAD_CONNECTOR_ID = '99999999-9999-4999-8999-999999999999';
  const CONTAINER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const uploadBody = {
    idempotencyKey: 'idem-upload-1',
    name: 'PST intake',
    kind: 'snapshot',
    sources: ['email'],
    custodianIds: [],
    uploadCustodian: { email: 'jane@example.com', displayName: 'Jane Doe' },
    scope: {
      dateRange: { kind: 'all_time' },
      uploads: { evidenceItemIds: [CONTAINER_ID] },
    },
  };

  function uploadModels(overrides: Record<string, unknown> = {}) {
    return {
      collection: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.created })),
      },
      connectorAccount: {
        findFirst: vi.fn(async () => ({ id: UPLOAD_CONNECTOR_ID, mode: 'organization' })),
        create: vi.fn(async () => ({ id: UPLOAD_CONNECTOR_ID, mode: 'organization' })),
      },
      custodian: {
        upsert: vi.fn(async () => ({ id: CUSTODIAN_ID })),
        findMany: vi.fn(async () => [{ id: CUSTODIAN_ID }]),
      },
      evidenceItem: {
        findMany: vi.fn(async () => [
          { id: CONTAINER_ID, kind: 'container', provider: 'upload', collectionId: null },
        ]),
      },
      tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
      collectionCustodian: { createMany: vi.fn(async () => ({ count: 1 })) },
      outboxEvent: { create: vi.fn(async () => ({})) },
      ...overrides,
    };
  }

  it('reuses the synthetic upload connector, upserts the custodian, and enqueues discover', async () => {
    const models = uploadModels();
    const { service } = makeService(models);

    const result = await service.create(auth, uploadBody, fakeRequest());
    expect(result).toEqual({ id: COLLECTION_ID, status: 'created', replayed: false });

    // Existing synthetic connector is reused, never duplicated.
    expect(models.connectorAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID, provider: 'upload' } }),
    );
    expect(models.connectorAccount.create).not.toHaveBeenCalled();

    // Declared custodian is upserted under the synthetic connector.
    const upsertArgs = models.custodian.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
    };
    expect(upsertArgs.create).toMatchObject({
      connectorAccountId: UPLOAD_CONNECTOR_ID,
      externalId: 'jane@example.com',
      email: 'jane@example.com',
      displayName: 'Jane Doe',
    });

    // The collection hangs off the synthetic connector.
    const collectionData = (
      models.collection.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(collectionData.connectorAccountId).toBe(UPLOAD_CONNECTOR_ID);
    expect(collectionData.sources).toEqual(['email']);

    const outboxArgs = models.outboxEvent.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(outboxArgs.data.topic).toBe('collection.discover');
  });

  it('creates the synthetic connector on first use', async () => {
    const models = uploadModels({
      connectorAccount: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: UPLOAD_CONNECTOR_ID, mode: 'organization' })),
      },
    });
    const { service } = makeService(models);

    await service.create(auth, uploadBody, fakeRequest());

    const createArgs = (models.connectorAccount as { create: ReturnType<typeof vi.fn> }).create.mock
      .calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArgs.data).toMatchObject({
      provider: 'upload',
      mode: 'organization',
      label: 'File uploads',
      externalIdentity: 'uploaded files',
      status: 'connected',
    });
  });

  it('returns 409 when a container is already claimed by another collection', async () => {
    const models = uploadModels({
      evidenceItem: {
        findMany: vi.fn(async () => [
          {
            id: CONTAINER_ID,
            kind: 'container',
            provider: 'upload',
            collectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ]),
      },
    });
    const { service } = makeService(models);
    await expect(service.create(auth, uploadBody, fakeRequest())).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects evidence items that are not uploaded containers', async () => {
    const models = uploadModels({
      evidenceItem: {
        findMany: vi.fn(async () => [
          { id: CONTAINER_ID, kind: 'email', provider: 'microsoft', collectionId: null },
        ]),
      },
    });
    const { service } = makeService(models);
    await expect(service.create(auth, uploadBody, fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects upload collections with non-email sources or ambiguous custodian input', async () => {
    const { service } = makeService(uploadModels());
    await expect(
      service.create(
        auth,
        { ...uploadBody, idempotencyKey: 'idem-upload-2', sources: ['email', 'drive'] },
        fakeRequest(),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        auth,
        { ...uploadBody, idempotencyKey: 'idem-upload-3', custodianIds: [CUSTODIAN_ID] },
        fakeRequest(),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CollectionsService.action', () => {
  it('rejects illegal transitions with 409 (pause on a completed collection)', async () => {
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.completed })),
      },
    });
    await expect(service.action(auth, COLLECTION_ID, 'pause', fakeRequest())).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects unknown actions with 400', async () => {
    const { service } = makeService({});
    await expect(service.action(auth, COLLECTION_ID, 'explode', fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('retry re-enqueues ONLY failed items with per-item worker payloads', async () => {
    const failedQuery = vi.fn(async () => [
      {
        id: 'ci-1',
        custodianId: CUSTODIAN_ID,
        source: 'email',
        providerItemId: 'msg-1',
        attempts: 2,
      },
    ]);
    const outboxCreateMany = vi.fn(async () => ({ count: 1 }));
    const collectionUpdate = vi.fn(async () => ({}));
    const { service, audit } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.failed })),
        update: collectionUpdate,
      },
      collectionItem: { findMany: failedQuery },
      // Retry now also sweeps processing exceptions, so these must exist.
      evidenceItem: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({})) },
      collectionException: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({})) },
      outboxEvent: { createMany: outboxCreateMany },
    });

    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedItems).toBe(1);

    // Only failed items are selected.
    const where = (failedQuery.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where.state).toBe('failed');

    const rows = (outboxCreateMany.mock.calls[0]?.[0] as { data: Record<string, unknown>[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe('collection.fetch-item');
    expect(rows[0]?.dedupKey).toBe(`item:${COLLECTION_ID}:${CUSTODIAN_ID}:email:msg-1:a2`);
    expect(rows[0]?.payload).toEqual({
      tenantId: TENANT_ID,
      collectionId: COLLECTION_ID,
      custodianId: CUSTODIAN_ID,
      source: 'email',
      providerItemId: 'msg-1',
    });
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'collection.retried' }),
    );
  });

  it('resume flips to fetching and enqueues a fresh discover with a resume dedup key', async () => {
    const outboxCreate = vi.fn(async () => ({}));
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.paused })),
        update: vi.fn(async () => ({})),
      },
      outboxEvent: { count: vi.fn(async () => 1), create: outboxCreate },
    });
    const result = await service.action(auth, COLLECTION_ID, 'resume', fakeRequest());
    expect(result.status).toBe(CollectionStatus.fetching);
    const args = outboxCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(args.data.dedupKey).toBe(`discover:${COLLECTION_ID}:resume:2`);
  });
});

describe('CollectionsService.manifestDownload', () => {
  function withCollection(row: Record<string, unknown> | null, store?: unknown) {
    return makeService(
      { collection: { findFirst: vi.fn(async () => row) } },
      store ? { store } : undefined,
    );
  }

  it('returns presigned URLs and the manifest hash for verification', async () => {
    const { service, audit } = withCollection({
      id: COLLECTION_ID,
      manifestKey: `tenants/${TENANT_ID}/manifests/${COLLECTION_ID}/manifest.json`,
      manifestSha256: 'a'.repeat(64),
      status: 'completed',
    });

    const result = await service.manifestDownload(auth, COLLECTION_ID, fakeRequest());

    expect(result.manifestSha256).toBe('a'.repeat(64));
    expect(result.manifestUrl).toContain('manifest.json');
    expect(result.expiresInSeconds).toBeGreaterThan(0);
    // Downloading the custody artifact is itself an audited act.
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'collection.manifest_downloaded' }),
    );
  });

  it('signs an attachment filename so the browser saves rather than renders it', async () => {
    const presignGet = vi.fn(async () => 'https://signed/x');
    const { service } = withCollection(
      {
        id: COLLECTION_ID,
        manifestKey: 'k',
        manifestSha256: 'b'.repeat(64),
        status: 'completed',
      },
      { presignGet },
    );

    await service.manifestDownload(auth, COLLECTION_ID, fakeRequest());
    expect(presignGet.mock.calls[0]?.[2]).toMatchObject({
      downloadFilename: `collection-${COLLECTION_ID}-manifest.json`,
    });
  });

  it('explains that an unfinalized collection has no manifest yet, rather than 404ing', async () => {
    // A 404 here reads as "your collection is gone", which is alarming and wrong.
    const { service } = withCollection({
      id: COLLECTION_ID,
      manifestKey: '',
      manifestSha256: '',
      status: 'fetching',
    });
    await expect(service.manifestDownload(auth, COLLECTION_ID, fakeRequest())).rejects.toThrow(
      ConflictException,
    );
  });

  it('404s for a collection in another tenant', async () => {
    const { service } = withCollection(null);
    await expect(service.manifestDownload(auth, COLLECTION_ID, fakeRequest())).rejects.toThrow();
  });

  it('still returns the manifest when the completeness report is missing', async () => {
    // Older collections predate the report; its absence must not block custody.
    const presignGet = vi
      .fn()
      .mockResolvedValueOnce('https://signed/manifest')
      .mockRejectedValueOnce(new Error('NoSuchKey'));
    const { service } = withCollection(
      { id: COLLECTION_ID, manifestKey: 'k', manifestSha256: 'c'.repeat(64), status: 'completed' },
      { presignGet },
    );

    const result = await service.manifestDownload(auth, COLLECTION_ID, fakeRequest());
    expect(result.manifestUrl).toBe('https://signed/manifest');
    expect(result.completenessReportUrl).toBeNull();
  });
});

describe('CollectionsService.exceptions — the ledger must identify what failed', () => {
  function withExceptions(rows: Record<string, unknown>[]) {
    return makeService({
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      collectionException: { findMany: vi.fn(async () => rows) },
    });
  }

  const base = {
    id: 'exc-1',
    kind: 'unsupported_item',
    message: 'document type is not supported by the text extractor',
    occurredAt: new Date('2026-08-14T02:29:21.000Z'),
  };

  it('names the file from detail when providerItemId is empty', async () => {
    // Anything extracted from a container has no id in the source system, so
    // the ledger previously showed a bare dash and told a reviewer nothing.
    const { service } = withExceptions([
      {
        ...base,
        providerItemId: '',
        detail: {
          evidenceItemId: ITEM_A,
          name: 'SWAP_Calendar.pub',
          mimeType: 'application/x-mspublisher',
          sizeBytes: 95232,
        },
      },
    ]);

    const page = await service.exceptions(auth, COLLECTION_ID, { limit: 10 });
    expect(page.items[0]).toMatchObject({
      itemRef: 'SWAP_Calendar.pub',
      evidenceItemId: ITEM_A,
      mimeType: 'application/x-mspublisher',
      sizeBytes: 95232,
    });
  });

  it('prefers a real providerItemId over the recorded name', async () => {
    const { service } = withExceptions([
      { ...base, providerItemId: 'AAMkAD…', detail: { name: 'ignored.pub' } },
    ]);
    const page = await service.exceptions(auth, COLLECTION_ID, { limit: 10 });
    expect(page.items[0]?.itemRef).toBe('AAMkAD…');
  });

  it('reports null rather than inventing a reference for legacy rows', async () => {
    // Rows written before detail existed carry {}; claiming an identity we do
    // not have would be worse than admitting we cannot name the item.
    const { service } = withExceptions([{ ...base, providerItemId: '', detail: {} }]);
    const page = await service.exceptions(auth, COLLECTION_ID, { limit: 10 });
    expect(page.items[0]).toMatchObject({
      itemRef: null,
      evidenceItemId: null,
      mimeType: null,
      sizeBytes: null,
    });
  });

  it('tolerates a detail payload with unexpected types', async () => {
    const { service } = withExceptions([
      { ...base, providerItemId: '', detail: { name: 42, sizeBytes: 'big', mimeType: null } },
    ]);
    const page = await service.exceptions(auth, COLLECTION_ID, { limit: 10 });
    expect(page.items[0]).toMatchObject({ itemRef: null, sizeBytes: null, mimeType: null });
  });
});

describe('CollectionsService.action — retry covers processing exceptions', () => {
  const EXCEPTED_ID = '66666666-6666-4666-8666-666666666666';

  function retryService(opts: {
    failedFetches?: Record<string, unknown>[];
    exceptedItems?: Record<string, unknown>[];
    ledger?: Record<string, unknown>[];
  }) {
    const outboxCreateMany = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({}));
    const { service, audit } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.completed })),
        update: vi.fn(async () => ({})),
      },
      collectionItem: { findMany: vi.fn(async () => opts.failedFetches ?? []) },
      evidenceItem: { findMany: vi.fn(async () => opts.exceptedItems ?? []), updateMany },
      collectionException: { findMany: vi.fn(async () => opts.ledger ?? []), deleteMany },
      outboxEvent: { createMany: outboxCreateMany },
    });
    return { service, audit, outboxCreateMany, updateMany, deleteMany };
  }

  it('re-enqueues extraction for items stuck in exception', async () => {
    // The original complaint: bytes collected fine, extraction failed, and
    // Retry did nothing because it only looked at failed fetches.
    const { service, outboxCreateMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 1 }],
    });

    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());

    expect(result.retriedProcessing).toBe(1);
    const topics = outboxCreateMany.mock.calls.flatMap((c) =>
      ((c[0] as { data: { topic: string }[] }).data ?? []).map((d) => d.topic),
    );
    expect(topics).toContain('process.extract');
  });

  it('uses a fresh dedup key so the outbox does not drop the retry', async () => {
    const { service, outboxCreateMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 2 }],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    const rows = (outboxCreateMany.mock.calls[0]![0] as { data: { dedupKey: string }[] }).data;
    // Reusing the original key would look like an already-dispatched event and
    // be skipped silently — the retry would appear to work and do nothing.
    expect(rows[0]?.dedupKey).toContain(EXCEPTED_ID);
    expect(rows[0]?.dedupKey).toMatch(/retry/);
  });

  it('moves retried items off exception so the UI shows queued work', async () => {
    const { service, updateMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 1 }],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processingStatus: 'pending' } }),
    );
  });

  it('clears only the ledger rows belonging to the retried items', async () => {
    const { service, deleteMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 1 }],
      ledger: [
        { id: 'exc-mine', detail: { evidenceItemId: EXCEPTED_ID } },
        { id: 'exc-other', detail: { evidenceItemId: ITEM_A } },
        { id: 'exc-legacy', detail: {} },
      ],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    // An unrelated item's exception, and a legacy row that cannot be matched,
    // must survive: silently dropping them would understate the exceptions.
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['exc-mine'] } } });
  });

  it('does not touch the ledger when there is nothing to retry', async () => {
    const { service, deleteMany, updateMany } = retryService({});
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedProcessing).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('records both counts in the audit chain', async () => {
    const { service, audit } = retryService({
      failedFetches: [
        { id: 'ci-1', custodianId: 'c1', source: 'email', providerItemId: 'p1', attempts: 1 },
      ],
      exceptedItems: [{ id: EXCEPTED_ID, version: 1 }],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'collection.retried',
        summary: expect.objectContaining({ retriedItems: 1, retriedProcessing: 1 }),
      }),
    );
  });
});
