import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  CollectionStatus,
  ConnectorStatus,
  MalwareStatus,
  ProcessingStatus,
  TenantRole,
} from '@aeg-clouddfir/database';
import {
  collectionPhaseProgress,
  collectionThroughputPace,
  collectionThroughputResponse,
  collectionThroughputState,
  type CollectionThroughputBucket,
} from '@aeg-clouddfir/contracts';
// Imported to assert the UI's stall fuse is the SAME one the worker's sweeper
// uses. A shorter fuse in the UI means an alarm nothing is acting on.
import { STALL_AFTER_MS as WORKER_STALL_AFTER_MS } from '../../../worker/src/stalled-items.js';
import { CollectionsService, isDiscoveryFailureMessage } from './collections.service.js';
import {
  STALL_AFTER_MS,
  completeBuckets,
  computePace,
  decideState,
  fillBuckets,
  historyBucketMinutes,
  isSlowNow,
  percentile,
  phaseProgress,
  windowName,
  type StateFacts,
} from './throughput.js';
import {
  CONNECTOR_ID,
  ITEM_A,
  MEMBERSHIP_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.case_manager]);
const COLLECTION_ID = '77777777-7777-4777-8777-777777777777';
const CASE_ID = '00000000-0000-4000-8000-0000000000ca';
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
  // Every collection now files itself under a case, so every create path
  // touches tx.case. Defaulted here rather than in each test: a test that
  // forgets it fails on a missing mock instead of on what it is checking.
  const prisma = fakePrisma({
    case: {
      create: vi.fn(async () => ({ id: CASE_ID })),
      findFirst: vi.fn(async () => ({ id: CASE_ID, status: 'open' })),
    },
    ...models,
  });
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
    // caseId is part of the response now: a collection always names the case
    // its evidence will be filed under, so the caller can link straight to it.
    expect(result).toEqual({
      id: COLLECTION_ID,
      status: 'created',
      replayed: false,
      caseId: CASE_ID,
    });

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
    // caseId is part of the response now: a collection always names the case
    // its evidence will be filed under, so the caller can link straight to it.
    expect(result).toEqual({
      id: COLLECTION_ID,
      status: 'created',
      replayed: false,
      caseId: CASE_ID,
    });
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
    // caseId is part of the response now: a collection always names the case
    // its evidence will be filed under, so the caller can link straight to it.
    expect(result).toEqual({
      id: COLLECTION_ID,
      status: 'created',
      replayed: false,
      caseId: CASE_ID,
    });

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
      collectionItem: { findMany: failedQuery, updateMany: vi.fn(async () => ({ count: 0 })) },
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

  it('hands a case-restricted caller the manifest of a collection filed under their case', async () => {
    const count = vi.fn(async () => 1);
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          manifestKey: 'k',
          manifestSha256: 'e'.repeat(64),
          status: 'completed',
          caseId: CASE_ID,
        })),
      },
      caseMember: { count },
    });
    const result = await service.manifestDownload(
      makeAuth([TenantRole.read_only]),
      COLLECTION_ID,
      fakeRequest(),
    );
    expect(result.manifestSha256).toBe('e'.repeat(64));
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ caseId: CASE_ID, membershipId: MEMBERSHIP_ID }),
      }),
    );
  });

  it('404s a case-restricted caller for a collection filed under a case they are not on', async () => {
    // One in-case item names the collection on the chain of custody. The
    // manifest is the whole collection, including items that were never added
    // to their case.
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          manifestKey: 'k',
          manifestSha256: 'd'.repeat(64),
          status: 'completed',
          caseId: CASE_ID,
        })),
      },
      caseMember: { count: vi.fn(async () => 0) },
    });
    await expect(
      service.manifestDownload(makeAuth([TenantRole.read_only]), COLLECTION_ID, fakeRequest()),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s a case-restricted caller when the collection has no case', async () => {
    const count = vi.fn(async () => 1);
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          manifestKey: 'k',
          manifestSha256: 'f'.repeat(64),
          status: 'completed',
          caseId: null,
        })),
      },
      caseMember: { count },
    });
    await expect(
      service.manifestDownload(makeAuth([TenantRole.read_only]), COLLECTION_ID, fakeRequest()),
    ).rejects.toThrow(NotFoundException);
    expect(count).not.toHaveBeenCalled();
  });

  it('does not ask a reviewer whether they sit on the collection case', async () => {
    const count = vi.fn(async () => 0);
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          manifestKey: 'k',
          manifestSha256: 'a'.repeat(64),
          status: 'completed',
          caseId: CASE_ID,
        })),
      },
      caseMember: { count },
    });
    const result = await service.manifestDownload(
      makeAuth([TenantRole.reviewer]),
      COLLECTION_ID,
      fakeRequest(),
    );
    expect(result.manifestSha256).toBe('a'.repeat(64));
    expect(count).not.toHaveBeenCalled();
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
      collectionItem: {
        findMany: vi.fn(async () => opts.failedFetches ?? []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
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
        { id: 'exc-mine', kind: 'unsupported_item', detail: { evidenceItemId: EXCEPTED_ID } },
        { id: 'exc-other', kind: 'unsupported_item', detail: { evidenceItemId: ITEM_A } },
        { id: 'exc-legacy', kind: 'other', detail: {} },
      ],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    // An unrelated item's exception, and a legacy row that cannot be matched,
    // must survive: silently dropping them would understate the exceptions.
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['exc-mine'] } } });
  });

  it('leaves object_missing items alone — extract cannot restore absent bytes', async () => {
    // PR #13 marks vanished natives as processingStatus=exception. The Retry
    // button used to re-queue extract for every exception, clear the ledger,
    // and leave emails (and already-extracted files) pending forever. Absent
    // bytes must stay named in the ledger until an operator acts on them.
    const findMany = vi.fn(async () => []);
    const outboxCreateMany = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({}));
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          status: CollectionStatus.completed,
        })),
        update: vi.fn(async () => ({})),
      },
      collectionItem: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      evidenceItem: { findMany, updateMany },
      collectionException: { findMany: vi.fn(async () => []), deleteMany },
      outboxEvent: { createMany: outboxCreateMany },
    });

    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());

    expect(result.retriedProcessing).toBe(0);
    expect(outboxCreateMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    // The query itself must refuse object_missing, not rely on post-filtering.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          processingStatus: ProcessingStatus.exception,
          malwareStatus: { not: MalwareStatus.object_missing },
          NOT: { processingDetail: { startsWith: 'evidence object is MISSING' } },
        }),
      }),
    );
  });

  it('never deletes an object_missing ledger row even when clearing siblings', async () => {
    const { service, deleteMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 1 }],
      ledger: [
        { id: 'exc-extract', kind: 'unsupported_item', detail: { evidenceItemId: EXCEPTED_ID } },
        // Same evidence item also has an object_missing row (scan and extract
        // both noticed). Clearing it would erase the only honest record.
        { id: 'exc-missing', kind: 'object_missing', detail: { evidenceItemId: EXCEPTED_ID } },
      ],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['exc-extract'] } } });
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

  it('re-queues a failed email through parse, not extract', async () => {
    // process.extract returns immediately for emails. Retrying them as extract
    // left the item pending, deleted the ledger row, and never created attachments.
    const { service, outboxCreateMany, updateMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 3, kind: 'email', custodianId: CUSTODIAN_ID }],
    });
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedProcessing).toBe(1);
    const rows = (outboxCreateMany.mock.calls[0]![0] as { data: { topic: string }[] }).data;
    expect(rows).toEqual([expect.objectContaining({ topic: 'process.parse' })]);
    expect(updateMany).toHaveBeenCalled();
  });

  it('re-queues a failed PST through pst.extract, not Tika', async () => {
    // Tika on a container can "succeed" with garbage text and never reconstruct
    // the messages. pst.extract is the only reader that does.
    const { service, outboxCreateMany } = retryService({
      exceptedItems: [
        { id: EXCEPTED_ID, version: 1, kind: 'container', custodianId: CUSTODIAN_ID },
      ],
    });
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    const rows = (
      outboxCreateMany.mock.calls[0]![0] as {
        data: { topic: string; payload: { collectionId: string; custodianId: string } }[];
      }
    ).data;
    expect(rows[0]?.topic).toBe('pst.extract');
    expect(rows[0]?.payload).toMatchObject({
      collectionId: COLLECTION_ID,
      custodianId: CUSTODIAN_ID,
      evidenceItemId: EXCEPTED_ID,
    });
  });

  it('does not send a container with no custodian to extract', async () => {
    const { service, outboxCreateMany, updateMany, deleteMany } = retryService({
      exceptedItems: [{ id: EXCEPTED_ID, version: 1, kind: 'container', custodianId: null }],
      ledger: [{ id: 'exc-mine', detail: { evidenceItemId: EXCEPTED_ID } }],
    });
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedProcessing).toBe(0);
    expect(outboxCreateMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('Retry re-runs discovery when enumeration never listed a mailbox', () => {
  it('recognises only the discover processor prefixes', () => {
    expect(isDiscoveryFailureMessage('discovery failed: mailbox not found')).toBe(true);
    expect(isDiscoveryFailureMessage('audit discovery failed: token expired')).toBe(true);
    expect(isDiscoveryFailureMessage('GET /messages/xyz returned 503')).toBe(false);
    expect(isDiscoveryFailureMessage(undefined)).toBe(false);
  });

  it('enqueues a fresh collection.discover when Retry sees a discovery exception and no items', async () => {
    // Trigger: every mailbox listing threw, the collection is failed, the
    // original discover:{id} key is already dispatched. Clicking Retry used
    // to report success, queue nothing, and leave the mailbox uncollected.
    const outboxCreate = vi.fn(async () => ({}));
    const outboxCreateMany = vi.fn(async () => ({ count: 0 }));
    const collectionUpdate = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({}));
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.failed })),
        update: collectionUpdate,
      },
      collectionItem: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      evidenceItem: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({})) },
      collectionException: {
        findMany: vi.fn(async () => [
          {
            id: 'exc-discover',
            kind: 'api_error',
            message: 'discovery failed: unauthorized_client',
            detail: {},
          },
        ]),
        deleteMany,
      },
      outboxEvent: { createMany: outboxCreateMany, create: outboxCreate },
    });

    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());

    expect(result.retriedDiscovery).toBe(1);
    expect(result.retriedItems).toBe(0);
    expect(result.status).toBe(CollectionStatus.fetching);
    const created = outboxCreate.mock.calls[0]?.[0] as {
      data: { topic: string; dedupKey: string };
    };
    expect(created.data.topic).toBe('collection.discover');
    expect(created.data.dedupKey).toMatch(new RegExp(`^discover:${COLLECTION_ID}:retry\\d+$`));
    expect(created.data.dedupKey).not.toBe(`discover:${COLLECTION_ID}`);
    expect(collectionUpdate).toHaveBeenCalledWith({
      where: { id: COLLECTION_ID },
      data: { status: CollectionStatus.fetching, finishedAt: null },
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['exc-discover'] } } });
  });

  it('does not re-discover a fetch failure that uses the same ledger kind', async () => {
    const outboxCreate = vi.fn(async () => ({}));
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.completed })),
        update: vi.fn(async () => ({})),
      },
      collectionItem: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      evidenceItem: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({})) },
      collectionException: {
        findMany: vi.fn(async () => [
          {
            id: 'exc-fetch',
            kind: 'api_error',
            message: 'GET /messages/abc returned 503',
            detail: { evidenceItemId: ITEM_A },
          },
        ]),
        deleteMany: vi.fn(async () => ({})),
      },
      outboxEvent: { createMany: vi.fn(async () => ({ count: 0 })), create: outboxCreate },
    });

    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedDiscovery).toBe(0);
    expect(outboxCreate).not.toHaveBeenCalled();
  });
});

describe('CollectionsService.create files the collection under a case', () => {
  /**
   * Collecting was only half the job. The evidence had to be reviewable, and
   * that meant creating a case by hand and adding the collection to it — a
   * step easy to forget, and silent when forgotten: the collection showed as
   * completed while nothing in it could be opened.
   */
  function baseModels(over: Record<string, unknown> = {}) {
    return {
      collection: {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.created })),
      },
      connectorAccount: {
        findFirst: vi.fn(async () => ({ id: CONNECTOR_ID, status: ConnectorStatus.connected })),
      },
      custodian: { findMany: vi.fn(async () => [{ id: CUSTODIAN_ID }]) },
      tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
      collectionCustodian: { createMany: vi.fn(async () => ({ count: 1 })) },
      outboxEvent: { create: vi.fn(async () => ({})) },
      ...over,
    };
  }

  const body = () => ({
    idempotencyKey: 'idem-case-0001',
    connectorAccountId: CONNECTOR_ID,
    name: 'Rorke mailbox',
    sources: ['email'],
    custodianIds: [CUSTODIAN_ID],
    scope: { dateRange: { kind: 'all_time' } },
  });

  it('creates a case named after the collection and links the two', async () => {
    const caseCreate = vi.fn(async () => ({ id: CASE_ID }));
    const collectionCreate = vi.fn(async () => ({
      id: COLLECTION_ID,
      status: CollectionStatus.created,
    }));
    const { service } = makeService(
      baseModels({
        case: { create: caseCreate, findFirst: vi.fn() },
        collection: {
          findFirst: vi.fn(async () => null),
          count: vi.fn(async () => 0),
          create: collectionCreate,
        },
      }),
    );

    await service.create(auth, body(), fakeRequest());

    const created = caseCreate.mock.calls[0]?.[0] as { data: { name: string } };
    expect(created.data.name).toContain('Rorke mailbox');
    // The link is what makes the evidence findable later.
    const linked = collectionCreate.mock.calls[0]?.[0] as { data: { caseId: string } };
    expect(linked.data.caseId).toBe(CASE_ID);
  });

  it('uses an existing case when the request names one', async () => {
    // A matter runs several collections — one per custodian, or a second pass
    // after a scope change. Each making its own case would scatter the matter.
    const caseCreate = vi.fn();
    const { service } = makeService(
      baseModels({
        case: {
          create: caseCreate,
          findFirst: vi.fn(async () => ({ id: CASE_ID, status: 'open' })),
        },
      }),
    );
    await service.create(auth, { ...body(), caseId: CASE_ID }, fakeRequest());
    expect(caseCreate).not.toHaveBeenCalled();
  });

  it('refuses to collect into a closed case', async () => {
    const { service } = makeService(
      baseModels({
        case: {
          create: vi.fn(),
          findFirst: vi.fn(async () => ({ id: CASE_ID, status: 'closed' })),
        },
      }),
    );
    await expect(
      service.create(auth, { ...body(), caseId: CASE_ID }, fakeRequest()),
    ).rejects.toThrow(/closed case/);
  });

  it('404s on a case id from another tenant', async () => {
    const { service } = makeService(
      baseModels({ case: { create: vi.fn(), findFirst: vi.fn(async () => null) } }),
    );
    await expect(
      service.create(auth, { ...body(), caseId: CASE_ID }, fakeRequest()),
    ).rejects.toThrow();
  });

  it('audits the case it invented, so nobody wonders where it came from', async () => {
    const { service, audit } = makeService(
      baseModels({ case: { create: vi.fn(async () => ({ id: CASE_ID })), findFirst: vi.fn() } }),
    );
    await service.create(auth, body(), fakeRequest());
    const actions = audit.appendTx.mock.calls.map((c) => (c[1] as { action: string }).action);
    expect(actions).toContain('case.created');
    expect(actions).toContain('collection.created');
  });
});

describe('retry recovers indexing failures without re-downloading', () => {
  /**
   * The production failure this exists for: an overloaded worker timed out on
   * database transactions inside the search-index stage, and 15,624 items were
   * marked failed with "search indexing failed". Every one still had its bytes
   * and its sha256. Re-fetching them would have pulled 15,624 messages from
   * Microsoft to replace files already on disk, byte for byte.
   */
  const preserved = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `ci-${String(i)}`,
      custodianId: CUSTODIAN_ID,
      source: 'email',
      providerItemId: `msg-${String(i)}`,
      attempts: 1,
      // Present = the bytes were collected. This is the whole signal.
      evidenceItemId: `ev-${String(i)}`,
    }));

  const notCollected = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `nf-${String(i)}`,
      custodianId: CUSTODIAN_ID,
      source: 'email',
      providerItemId: `gone-${String(i)}`,
      attempts: 1,
      evidenceItemId: null,
    }));

  function retryService(items: Record<string, unknown>[]) {
    const outboxCreateMany = vi.fn(async () => ({ count: 0 }));
    const itemUpdateMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }));
    const { service } = makeService({
      collection: {
        findFirst: vi.fn(async () => ({ id: COLLECTION_ID, status: CollectionStatus.failed })),
        update: vi.fn(async () => ({})),
      },
      collectionItem: { findMany: vi.fn(async () => items), updateMany: itemUpdateMany },
      evidenceItem: {
        findMany: vi.fn(async (args: { where: { id?: { in?: string[] } } }) =>
          (args.where.id?.in ?? []).map((id) => ({ id, version: 1 })),
        ),
        updateMany: vi.fn(async () => ({})),
      },
      collectionException: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({})) },
      outboxEvent: { createMany: outboxCreateMany },
    });
    return { service, outboxCreateMany, itemUpdateMany };
  }

  /** Every outbox row the retry wrote, flattened. */
  function topics(outbox: ReturnType<typeof vi.fn>): string[] {
    return outbox.mock.calls.flatMap((c) =>
      (c[0] as { data: { topic: string }[] }).data.map((d) => d.topic),
    );
  }

  it('re-indexes an item whose bytes are already preserved', async () => {
    const { service, outboxCreateMany } = retryService(preserved(3));
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedIndexing).toBe(3);
    expect(topics(outboxCreateMany)).toContain('search.index');
  });

  it('does NOT call the provider for anything already collected', async () => {
    // The point of the whole change.
    const { service, outboxCreateMany } = retryService(preserved(3));
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(topics(outboxCreateMany)).not.toContain('collection.fetch-item');
    expect(result.retriedItems).toBe(0);
  });

  it('still re-fetches items that have no preserved bytes', async () => {
    const { service, outboxCreateMany } = retryService(notCollected(2));
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedItems).toBe(2);
    expect(result.retriedIndexing).toBe(0);
    expect(topics(outboxCreateMany)).toContain('collection.fetch-item');
  });

  it('splits a mixed batch, reporting each separately', async () => {
    const { service } = retryService([...preserved(4), ...notCollected(2)]);
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedIndexing).toBe(4);
    expect(result.retriedItems).toBe(2);
  });

  it('gives the re-index round a fresh dedup key', async () => {
    // A dedup key works once, ever, and these items were already indexed at
    // this version — that attempt is what failed. Without a round marker the
    // outbox drops every row and the retry silently does nothing.
    const { service, outboxCreateMany } = retryService(preserved(1));
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    const keys = outboxCreateMany.mock.calls.flatMap((c) =>
      (c[0] as { data: { topic: string; dedupKey: string }[] }).data
        .filter((d) => d.topic === 'search.index')
        .map((d) => d.dedupKey),
    );
    expect(keys[0]).toMatch(/:retry\d+$/);
  });

  it('moves re-indexed items back to preserved, not left failed', async () => {
    // The bytes ARE preserved; only indexing is outstanding. Leaving them
    // 'failed' understates what was collected, and finalize counts preserved
    // as in flight so the collection waits instead of sealing short.
    const { service, itemUpdateMany } = retryService(preserved(2));
    await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    const data = itemUpdateMany.mock.calls[0]?.[0] as { data: { state: string } };
    expect(data.data.state).toBe('preserved');
  });

  it('handles a real-sized failure without sixteen rounds of clicking', async () => {
    // 15,770 items failed for real. The old 1,000 cap applied to everything.
    const { service } = retryService(preserved(15_770));
    const result = await service.action(auth, COLLECTION_ID, 'retry', fakeRequest());
    expect(result.retriedIndexing).toBe(15_770);
  });
});

describe('throughput state machine — what a user is told, and when', () => {
  /**
   * The valuable part of this feature is not the picture, it is the words. These
   * cases are the rules written down, each one grounded in the biggest real run:
   * 185,379 provider items became 434,910 evidence items and 130 GB between
   * 2026-09-10 19:43 and 2026-09-14 16:56. Acquisition took 66.00 h; the run took
   * 93.22 h; so 27.22 h — 29% — was the processing tail.
   */
  const NOW = new Date('2026-09-14T16:56:00.000Z');

  const zeroStates = {
    discovered: 0,
    fetching: 0,
    preserved: 0,
    processed: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
  };

  /** n complete minute-buckets, each carrying `items`. */
  function minuteBuckets(n: number, items: number, from = NOW): CollectionThroughputBucket[] {
    return Array.from({ length: n }, (_, i) => ({
      startedAt: new Date(from.getTime() - (n - i) * 60_000).toISOString(),
      minutesFromStart: i,
      items,
      bytes: items * 21 * 1024,
      cumulativeBytes: (i + 1) * items * 21 * 1024,
      idle: items === 0,
    }));
  }

  function facts(over: Partial<StateFacts> = {}): StateFacts {
    return {
      status: 'fetching',
      now: NOW,
      lastAcquiredAt: NOW,
      itemStates: { ...zeroStates, discovered: 1000, preserved: 500, indexed: 5000 },
      openPageCheckpoints: 0,
      exceptionCount: 0,
      rateLimitWaitMs: 0,
      previousRateLimitWaitMs: null,
      buckets: minuteBuckets(30, 101),
      bucketMinutes: 1,
      totalItems: 3030,
      ...over,
    };
  }

  it('agrees with the worker sweeper on when work is stalled', () => {
    // If the UI used a shorter fuse it would shout "stalled" about items the
    // sweeper has not decided are stuck and is not re-driving — an alarm with no
    // action behind it.
    expect(STALL_AFTER_MS).toBe(WORKER_STALL_AFTER_MS);
    expect(STALL_AFTER_MS).toBe(15 * 60_000);
  });

  it('says measuring, and states NO pace, under two full minutes', () => {
    const d = decideState(facts({ buckets: minuteBuckets(1, 400), totalItems: 400 }));
    expect(d.state).toBe('measuring');
    expect(d.showPace).toBe(false);
  });

  it('says measuring under 100 items even after many minutes', () => {
    // Two full minutes holding three items is a pace of 1.5/min that means
    // nothing. Publishing it would be worse than admitting we do not know.
    const d = decideState(facts({ buckets: minuteBuckets(30, 3), totalItems: 90 }));
    expect(d.state).toBe('measuring');
    expect(d.showPace).toBe(false);
  });

  it('starts stating a pace once both thresholds are passed', () => {
    const d = decideState(facts());
    expect(d.state).not.toBe('measuring');
    expect(d.showPace).toBe(true);
  });

  it('computePace returns nulls, never zeros, while measuring', () => {
    const pace = computePace(minuteBuckets(1, 4), { measuring: true, bucketMinutes: 1 });
    expect(pace.itemsPerMinute).toBeNull();
    expect(pace.bytesPerMinute).toBeNull();
    expect(pace.p10ItemsPerMinute).toBeNull();
  });

  it('says discovering while the status says the walk has not finished', () => {
    for (const status of ['created', 'discovering']) {
      expect(decideState(facts({ status })).state).toBe('discovering');
    }
  });

  it('says discovering while a page cursor is still open, whatever the status', () => {
    // A page checkpoint means the provider has pages this run has not walked, so
    // the total is provisional — and this run's total moved from 185,379 to
    // 434,910.
    expect(decideState(facts({ status: 'fetching', openPageCheckpoints: 2 })).state).toBe(
      'discovering',
    );
  });

  it('refuses a percentage while the denominator is moving', () => {
    const moving = phaseProgress({
      itemStates: { ...zeroStates, discovered: 100, indexed: 100 },
      denominatorMoving: true,
      acquisitionElapsedMs: 0,
      runElapsedMs: 0,
      acquisitionPace: computePace([], { measuring: true, bucketMinutes: 1 }),
      processingPace: computePace([], { measuring: true, bucketMinutes: 1 }),
    });
    expect(moving.acquisition.percent).toBeNull();
    expect(moving.acquisition.total).toBeNull();
    expect(moving.processing.percent).toBeNull();
  });

  it('gives a percentage once the denominator settles', () => {
    const settled = phaseProgress({
      itemStates: { ...zeroStates, indexed: 75, preserved: 25 },
      denominatorMoving: false,
      acquisitionElapsedMs: 0,
      runElapsedMs: 0,
      acquisitionPace: computePace([], { measuring: true, bucketMinutes: 1 }),
      processingPace: computePace([], { measuring: true, bucketMinutes: 1 }),
    });
    expect(settled.acquisition.percent).toBe(100);
    expect(settled.processing.percent).toBe(75);
  });

  it('says stalled after 15 minutes of nothing while work is in flight', () => {
    const d = decideState(
      facts({
        lastAcquiredAt: new Date(NOW.getTime() - 15 * 60_000),
        itemStates: { ...zeroStates, discovered: 2335, indexed: 5000 },
      }),
    );
    expect(d.state).toBe('stalled');
    expect(d.stateLabel).toBe('Stalled');
  });

  it('does NOT say stalled at 14 minutes', () => {
    const d = decideState(
      facts({
        lastAcquiredAt: new Date(NOW.getTime() - 14 * 60_000),
        itemStates: { ...zeroStates, discovered: 2335, indexed: 5000 },
      }),
    );
    expect(d.state).not.toBe('stalled');
  });

  it('does NOT say stalled when nothing is in flight — that is just finished work', () => {
    const d = decideState(
      facts({
        lastAcquiredAt: new Date(NOW.getTime() - 5 * 3600_000),
        itemStates: { ...zeroStates, indexed: 434910 },
      }),
    );
    expect(d.state).not.toBe('stalled');
  });

  it('says rate_limited, NOT stalled, when throttling rose — a job can be both', () => {
    // The false alarm this ordering exists to prevent: a collection politely
    // waiting on Microsoft is also idle, and a red "stalled" on a healthy job is
    // what teaches people to ignore alarms. Across the whole 66 h acquisition
    // throttling totalled 8.45 minutes, so a rise really is a signal.
    const d = decideState(
      facts({
        lastAcquiredAt: new Date(NOW.getTime() - 40 * 60_000),
        itemStates: { ...zeroStates, discovered: 100, fetching: 5 },
        previousRateLimitWaitMs: 500_000,
        rateLimitWaitMs: 507_000,
      }),
    );
    expect(d.state).toBe('rate_limited');
  });

  it('ignores throttling that did not move since the last poll', () => {
    const d = decideState(facts({ previousRateLimitWaitMs: 507_000, rateLimitWaitMs: 507_000 }));
    expect(d.state).not.toBe('rate_limited');
  });

  it('cannot say rate_limited on a first poll, because nothing has been compared', () => {
    const d = decideState(facts({ previousRateLimitWaitMs: null, rateLimitWaitMs: 507_000 }));
    expect(d.state).not.toBe('rate_limited');
  });

  it('says stalled rather than measuring for a young collection that stopped', () => {
    // Fifteen idle minutes with three items collected is stuck, not new.
    const d = decideState(
      facts({
        buckets: minuteBuckets(3, 1),
        totalItems: 3,
        lastAcquiredAt: new Date(NOW.getTime() - 20 * 60_000),
        itemStates: { ...zeroStates, discovered: 50 },
      }),
    );
    expect(d.state).toBe('stalled');
    // And it still refuses to invent a rate.
    expect(d.showPace).toBe(false);
  });

  it('says slow only against this run\u2019s OWN p10, never a fixed number', () => {
    // 29 minutes at the run's normal 101/min, then five minutes at 10/min. The
    // real run's p10 was 54 and its p99 384 — a fixed threshold would have
    // called its normal minutes slow and its slow minutes normal.
    const buckets = [...minuteBuckets(29, 101), ...minuteBuckets(5, 10)].map((b, i) => ({
      ...b,
      minutesFromStart: i,
    }));
    const d = decideState(
      facts({ buckets, totalItems: 2979, itemStates: { ...zeroStates, discovered: 500 } }),
    );
    expect(d.state).toBe('slow');

    // And the reason it fires: the yardstick excludes the minutes being judged.
    // The p10 of ALL 34 buckets is 10 — the dip itself — so "below p10" would be
    // false at the exact moment it should be true. This assertion is here so a
    // future simplification back to a whole-window p10 fails loudly.
    expect(
      percentile(
        buckets.map((b) => b.items),
        0.1,
      ),
    ).toBe(10);
    expect(isSlowNow(buckets, { bucketMinutes: 1 })).toBe(true);
  });

  it('does not call a run slow on the strength of two earlier minutes', () => {
    // Six buckets: one baseline minute is not a normal to be measured against.
    const buckets = [...minuteBuckets(2, 101), ...minuteBuckets(5, 10)].map((b, i) => ({
      ...b,
      minutesFromStart: i,
    }));
    expect(isSlowNow(buckets, { bucketMinutes: 1 })).toBe(false);
  });

  it('does not say slow for a normal minute of a fast run', () => {
    const d = decideState(
      facts({ buckets: minuteBuckets(30, 101), itemStates: { ...zeroStates, discovered: 500 } }),
    );
    expect(d.state).toBe('fetching');
  });

  it('says processing once acquisition is done but items are still preserved', () => {
    // The 27.22 h nobody could see. Every byte is here; 29% of the run remains.
    const d = decideState(
      facts({
        status: 'fetching',
        itemStates: { ...zeroStates, preserved: 300000, indexed: 134910 },
        totalItems: 434910,
      }),
    );
    expect(d.state).toBe('processing');
  });

  it('a finished collection with exceptions can NEVER report healthy', () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      const d = decideState(
        facts({
          status,
          exceptionCount: 1,
          itemStates: { ...zeroStates, indexed: 434909, skipped: 1 },
        }),
      );
      expect(d.state).toBe('finished');
      expect(d.health).not.toBe('healthy');
    }
  });

  it('a finished collection with failed items reports a problem, not attention', () => {
    const d = decideState(
      facts({ status: 'completed', itemStates: { ...zeroStates, indexed: 400000, failed: 10 } }),
    );
    expect(d.health).toBe('problem');
  });

  it('a clean finished collection is healthy', () => {
    const d = decideState(
      facts({ status: 'completed', exceptionCount: 0, itemStates: { ...zeroStates, indexed: 10 } }),
    );
    expect(d.state).toBe('finished');
    expect(d.health).toBe('healthy');
  });

  it('every state carries a word, because colour is never the only signal', () => {
    for (const state of collectionThroughputState.options) {
      const d = decideState(facts({ status: state === 'finished' ? 'completed' : 'fetching' }));
      expect(d.stateLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('throughput bucketing — gaps are drawn, and 3,948 minutes are not shipped', () => {
  it('downsamples the real run to about 200 buckets', () => {
    // 3,948 minutes at one point each, drawn on roughly 900 pixels, is four
    // points per pixel and not one extra thing visible.
    const width = historyBucketMinutes(3948);
    expect(width).toBe(20);
    expect(Math.ceil(3948 / width)).toBeLessThanOrEqual(200);
  });

  it('keeps one-minute buckets for a short run', () => {
    expect(historyBucketMinutes(45)).toBe(1);
    expect(historyBucketMinutes(200)).toBe(1);
    expect(historyBucketMinutes(0)).toBe(1);
  });

  it('fills a gap with idle buckets instead of closing it up', () => {
    // Closing the gap makes a stall look like steady work. The real run had 12
    // idle minutes out of 3,948 and no gap over 5.
    const from = new Date('2026-09-10T19:43:00.000Z');
    const buckets = fillBuckets(
      [
        { startedAt: from, items: 101, bytes: 1000 },
        { startedAt: new Date(from.getTime() + 4 * 60_000), items: 54, bytes: 500 },
      ],
      { from, to: new Date(from.getTime() + 4 * 60_000), bucketMinutes: 1 },
    );
    expect(buckets).toHaveLength(5);
    expect(buckets.map((b) => b.idle)).toEqual([false, true, true, true, false]);
    expect(buckets.map((b) => b.minutesFromStart)).toEqual([0, 1, 2, 3, 4]);
  });

  it('carries cumulative bytes forward across idle buckets', () => {
    const from = new Date('2026-09-10T19:43:00.000Z');
    const buckets = fillBuckets(
      [
        { startedAt: from, items: 1, bytes: 1000 },
        { startedAt: new Date(from.getTime() + 2 * 60_000), items: 1, bytes: 500 },
      ],
      { from, to: new Date(from.getTime() + 2 * 60_000), bucketMinutes: 1 },
    );
    expect(buckets.map((b) => b.cumulativeBytes)).toEqual([1000, 1000, 1500]);
  });

  it('starts the cumulative line from bytes already preserved before the window', () => {
    // The live window shows the last 60 minutes of a 66-hour acquisition.
    // Restarting the byte line at zero would misstate 130 GB as a few hundred MB.
    const from = new Date('2026-09-14T15:56:00.000Z');
    const alreadyPreserved = 130 * 1024 ** 3;
    const buckets = fillBuckets([{ startedAt: from, items: 1, bytes: 1000 }], {
      from,
      to: from,
      bucketMinutes: 1,
      bytesBefore: alreadyPreserved,
    });
    expect(buckets[0]?.cumulativeBytes).toBe(alreadyPreserved + 1000);
  });

  it('reports a pace per MINUTE even when a bucket is twenty minutes wide', () => {
    // A downsampled bucket holds twenty minutes of work. Reporting its total as a
    // rate would overstate the pace by exactly that factor.
    const from = new Date('2026-09-10T19:43:00.000Z');
    const wide = fillBuckets(
      [
        { startedAt: from, items: 2020, bytes: 0 },
        { startedAt: new Date(from.getTime() + 20 * 60_000), items: 2020, bytes: 0 },
      ],
      { from, to: new Date(from.getTime() + 20 * 60_000), bucketMinutes: 20 },
    );
    const pace = computePace(wide, { measuring: false, bucketMinutes: 20 });
    expect(pace.itemsPerMinute).toBe(101);
    expect(pace.p50ItemsPerMinute).toBe(101);
  });

  it('percentiles reproduce the real run\u2019s measured spread', () => {
    // p10 54, p50 101, p90 162, max 1,140 across 3,948 buckets.
    const values = [54, 54, 80, 101, 101, 101, 140, 162, 162, 1140];
    expect(percentile(values, 0.1)).toBe(54);
    expect(percentile(values, 0.5)).toBe(101);
    expect(percentile(values, 0.9)).toBe(162);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('counts only whole buckets as measured, so a partial minute cannot set the pace', () => {
    const now = new Date('2026-09-14T16:56:30.000Z');
    const buckets = fillBuckets(
      [{ startedAt: new Date('2026-09-14T16:55:00.000Z'), items: 400, bytes: 0 }],
      {
        from: new Date('2026-09-14T16:55:00.000Z'),
        to: now,
        bucketMinutes: 1,
      },
    );
    // Two buckets exist; the 16:56 one is still running.
    expect(buckets).toHaveLength(2);
    expect(completeBuckets(buckets, { now, bucketMinutes: 1 })).toHaveLength(1);
  });

  it('names the window rather than leaving the page to guess', () => {
    expect(windowName({ window: 'live', bucketMinutes: 1, bucketCount: 60 })).toContain(
      'last 60 minutes',
    );
    expect(windowName({ window: 'history', bucketMinutes: 20, bucketCount: 198 })).toBe(
      'whole run, 198 buckets of 20 minutes each',
    );
  });

  it('phase elapsed times split a run into acquisition and its tail', () => {
    // The real run: 93.22 h total, 66.00 h acquisition, so a 27.22 h tail.
    const phases = phaseProgress({
      itemStates: {
        discovered: 0,
        fetching: 0,
        preserved: 0,
        processed: 0,
        indexed: 434910,
        failed: 0,
        skipped: 0,
      },
      denominatorMoving: false,
      acquisitionElapsedMs: 66 * 3600_000,
      runElapsedMs: 93.22 * 3600_000,
      acquisitionPace: computePace([], { measuring: true, bucketMinutes: 1 }),
      processingPace: computePace([], { measuring: true, bucketMinutes: 1 }),
    });
    expect(phases.acquisition.elapsedMs).toBe(66 * 3600_000);
    expect(phases.processing.elapsedMs / 3600_000).toBeCloseTo(27.22, 2);
  });

  it('never returns a negative tail when the clocks disagree', () => {
    const phases = phaseProgress({
      itemStates: {
        discovered: 0,
        fetching: 0,
        preserved: 0,
        processed: 0,
        indexed: 1,
        failed: 0,
        skipped: 0,
      },
      denominatorMoving: false,
      acquisitionElapsedMs: 10_000,
      runElapsedMs: 5_000,
      acquisitionPace: computePace([], { measuring: true, bucketMinutes: 1 }),
      processingPace: computePace([], { measuring: true, bucketMinutes: 1 }),
    });
    expect(phases.processing.elapsedMs).toBe(0);
  });
});

describe('CollectionsService.throughput — the whole response, against the contract', () => {
  const NOW = new Date('2026-09-14T16:56:00.000Z');
  const FIRST = new Date('2026-09-14T16:00:00.000Z');

  /**
   * The two raw reads in order: bounds/totals, then the rollup. `size` is BigInt
   * in the column, so the real query returns it as text and the service converts
   * — these fixtures match that, because a test that hands back a JS number would
   * pass while production returned a string and silently produced NaN.
   */
  function throughputService(over: {
    status?: string;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    bounds?: Record<string, unknown>[];
    rollup?: Record<string, unknown>[];
    states?: { state: string; _count: { _all: number } }[];
    pageCheckpoints?: number;
    exceptions?: number;
    progress?: unknown;
  }) {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        over.bounds ?? [
          { firstAt: FIRST, lastAt: NOW, totalItems: 5000, totalBytes: '107374182400' },
        ],
      )
      .mockResolvedValueOnce(
        over.rollup ??
          Array.from({ length: 57 }, (_, i) => ({
            startedAt: new Date(FIRST.getTime() + i * 60_000),
            items: 101,
            bytes: '2170880',
          })),
      );
    const { service } = makeService({
      $queryRaw: queryRaw,
      collection: {
        findFirst: vi.fn(async () => ({
          id: COLLECTION_ID,
          status: over.status ?? 'fetching',
          sources: ['email'],
          startedAt: over.startedAt ?? FIRST,
          finishedAt: over.finishedAt ?? null,
          custodians: [{ progress: over.progress ?? { email: { rateLimitWaitMs: 507_000 } } }],
        })),
      },
      collectionItem: {
        groupBy: vi.fn(async () => over.states ?? [{ state: 'indexed', _count: { _all: 5000 } }]),
      },
      collectionCheckpoint: { count: vi.fn(async () => over.pageCheckpoints ?? 0) },
      collectionException: { count: vi.fn(async () => over.exceptions ?? 0) },
    });
    return { service, queryRaw };
  }

  it('returns a body the contract accepts, so the browser cannot reject it', async () => {
    // A mismatch here type-checks fine and then fails at runtime in the browser,
    // which is the exact failure packages/contracts exists to prevent.
    const { service } = throughputService({});
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    const parsed = collectionThroughputResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('converts the BigInt size column from text, not into NaN', async () => {
    const { service } = throughputService({});
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    expect(body.totals.bytes).toBe(107_374_182_400);
    expect(Number.isNaN(body.totals.bytes)).toBe(false);
    expect(body.buckets.every((b) => Number.isFinite(b.bytes))).toBe(true);
  });

  it('names the live window and buckets it by the minute', async () => {
    const { service } = throughputService({});
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    expect(body.bucketMinutes).toBe(1);
    expect(body.windowName).toContain('last 60 minutes');
  });

  it('downsamples a long history instead of shipping every minute', async () => {
    // 3,948 minutes is four points per pixel on a 900-pixel chart.
    const longFirst = new Date(NOW.getTime() - 3948 * 60_000);
    const { service } = throughputService({
      bounds: [{ firstAt: longFirst, lastAt: NOW, totalItems: 434910, totalBytes: '139586437120' }],
      rollup: [{ startedAt: longFirst, items: 101, bytes: '2170880' }],
    });
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'history', now: NOW });
    expect(body.bucketMinutes).toBe(20);
    expect(body.buckets.length).toBeLessThanOrEqual(200);
    expect(body.windowName).toContain('whole run');
  });

  it('sums provider throttling across every custodian and source', async () => {
    const { service } = throughputService({});
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    expect(body.rateLimitWaitMs).toBe(507_000);
  });

  it('lets the SERVER decide rate_limited from the echoed previous value', async () => {
    const { service } = throughputService({
      states: [
        { state: 'discovered', _count: { _all: 100 } },
        { state: 'indexed', _count: { _all: 5000 } },
      ],
    });
    const body = await service.throughput(auth, COLLECTION_ID, {
      window: 'live',
      now: NOW,
      previousRateLimitWaitMs: 500_000,
    });
    expect(body.state).toBe('rate_limited');
  });

  it('reports every item state, so the phase bar has real counts', async () => {
    const { service } = throughputService({
      states: [
        { state: 'preserved', _count: { _all: 300000 } },
        { state: 'indexed', _count: { _all: 134910 } },
      ],
    });
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    expect(body.itemStates.preserved).toBe(300000);
    expect(body.itemStates.indexed).toBe(134910);
    expect(body.itemStates.failed).toBe(0);
  });

  it('separates the acquisition clock from the processing tail', async () => {
    // 66.00 h acquisition inside a 93.22 h run.
    const first = new Date('2026-09-10T19:43:00.000Z');
    const lastByte = new Date(first.getTime() + 66 * 3600_000);
    const finished = new Date(first.getTime() + 93.22 * 3600_000);
    const { service } = throughputService({
      status: 'completed',
      startedAt: first,
      finishedAt: finished,
      bounds: [
        { firstAt: first, lastAt: lastByte, totalItems: 434910, totalBytes: '139586437120' },
      ],
      rollup: [{ startedAt: first, items: 101, bytes: '2170880' }],
    });
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'history', now: NOW });
    expect(body.totals.acquisitionElapsedMs).toBe(66 * 3600_000);
    expect(body.processing.elapsedMs / 3600_000).toBeCloseTo(27.22, 2);
  });

  it('404s a collection in another tenant before running any rollup', async () => {
    const queryRaw = vi.fn(async () => []);
    const { service } = makeService({
      $queryRaw: queryRaw,
      collection: { findFirst: vi.fn(async () => null) },
    });
    await expect(service.throughput(auth, COLLECTION_ID, { window: 'live' })).rejects.toThrow();
    // Tenant isolation is checked first, so a foreign id never costs a 225 ms scan.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('survives a collection that has acquired nothing at all', async () => {
    const { service } = throughputService({
      status: 'discovering',
      bounds: [{ firstAt: null, lastAt: null, totalItems: 0, totalBytes: '0' }],
      rollup: [],
      states: [],
    });
    const body = await service.throughput(auth, COLLECTION_ID, { window: 'live', now: NOW });
    expect(collectionThroughputResponse.safeParse(body).success).toBe(true);
    expect(body.buckets).toHaveLength(0);
    expect(body.acquisition.pace.itemsPerMinute).toBeNull();
    expect(body.state).toBe('measuring');
  });
});

describe('the throughput contract promises no forecast', () => {
  /** Words a field name would use if it carried a predicted finish. */
  const FORECAST_WORDS = ['eta', 'remaining', 'estimat', 'predict', 'finishesat', 'willfinish'];

  function namesAForecast(keys: string[]): boolean {
    const joined = JSON.stringify(keys).toLowerCase();
    return FORECAST_WORDS.some((word) => joined.includes(word));
  }

  it('has no field that could hold a predicted finish', () => {
    // The locked decision, enforced rather than remembered. Replaying the real
    // run, a 5-minute window was off -16% to +33%, a 30-minute window -25% to
    // +68%, and a low/high band missed at 4 of 9 checkpoints.
    expect(namesAForecast(Object.keys(collectionThroughputResponse.shape))).toBe(false);
    expect(namesAForecast(Object.keys(collectionPhaseProgress.shape))).toBe(false);
    expect(namesAForecast(Object.keys(collectionThroughputPace.shape))).toBe(false);
  });

  it('and the guard really would catch one', () => {
    // Asserted in both directions on purpose: a check that only ever sees a
    // clean schema passes whether or not it works. These are fixture names in a
    // test, not fields — nothing in the contract is being loosened.
    expect(namesAForecast(['items', 'estimatedRemainingMs'])).toBe(true);
    expect(namesAForecast(['items', 'etaSeconds'])).toBe(true);
    expect(namesAForecast(['items', 'willFinishAt'])).toBe(true);
    expect(namesAForecast(['items', 'bytes', 'elapsedMs'])).toBe(false);
  });
});
