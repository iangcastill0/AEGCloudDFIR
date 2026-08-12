import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CollectionStatus, ConnectorStatus, TenantRole } from '@evidencevault/database';
import { CollectionsService } from './collections.service.js';
import {
  CONNECTOR_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
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

function makeService(models: Record<string, unknown>) {
  const audit = fakeAudit();
  const prisma = fakePrisma(models);
  const service = new CollectionsService(prisma, audit.service);
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
