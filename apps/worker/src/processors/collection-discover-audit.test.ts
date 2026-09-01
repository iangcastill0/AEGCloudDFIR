import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../queues.js';
import { COLLECTION, TENANT, createManyRows, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import { ORG_AUDIT_EXTERNAL_ID, processCollectionDiscover } from './collection-discover.js';

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
const buildAuditConnectors = vi.mocked(factory.buildAuditConnectors);

const ACCOUNT = '44444444-4444-4444-8444-444444444444';

const payload = { tenantId: TENANT, collectionId: COLLECTION };

function armAuditOnlyCollection(f: FakeCtx): void {
  f.tx.collection.findUnique.mockResolvedValue({
    status: 'created',
    startedAt: null,
    sources: ['audit'],
    connectorAccountId: ACCOUNT,
    connectorAccount: { provider: 'microsoft' },
    scope: {
      dateRange: { kind: 'all_time' },
      audit: {
        microsoft: {
          managementContentTypes: ['Audit.Exchange'],
          includeGraphSignins: true,
          includeGraphDirectoryAudits: false,
        },
        actorFilter: [],
      },
    },
    custodians: [],
  });
  f.tx.custodian.upsert.mockResolvedValue({ id: 'org-cust-1' });
}

describe('processCollectionDiscover (audit source)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an org custodian, checkpoints, and fetch-page outbox for each audit scope', async () => {
    const f = fakeCtx();
    armAuditOnlyCollection(f);
    buildAuditConnectors.mockResolvedValue({
      provider: 'microsoft',
      mode: 'organization',
      connectors: [
        {
          kind: 'o365_management_activity',
          connector: {
            listAuditScopes: vi
              .fn()
              .mockResolvedValue([{ scopeKey: 'Audit.Exchange', label: 'Exchange' }]),
            fetchAuditPage: vi.fn(),
          },
        },
        {
          kind: 'graph_audit',
          connector: {
            listAuditScopes: vi
              .fn()
              .mockResolvedValue([{ scopeKey: 'signIns', label: 'Sign-ins' }]),
            fetchAuditPage: vi.fn(),
          },
        },
      ],
    } as never);

    await processCollectionDiscover(f.ctx, payload);

    // Synthetic org custodian created + linked.
    const custUpsert = f.tx.custodian.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
    };
    expect(custUpsert.create['externalId']).toBe(ORG_AUDIT_EXTERNAL_ID);
    expect(f.tx.collectionCustodian.upsert).toHaveBeenCalled();

    // A checkpoint per composed audit scope key.
    const checkpointKeys = f.tx.collectionCheckpoint.upsert.mock.calls.map(
      (c) => (c[0] as { create: { scopeKey: string; source: string } }).create,
    );
    expect(checkpointKeys.map((c) => c.scopeKey).sort()).toEqual([
      'graph_audit::signIns',
      'o365_management_activity::Audit.Exchange',
    ]);
    expect(checkpointKeys.every((c) => c.source === 'audit')).toBe(true);

    // fetch-page outbox for each scope, tagged source=audit.
    const outbox = createManyRows(f.tx.outboxEvent);
    const pages = outbox.filter((r) => r['topic'] === QUEUES.collectionFetchPage);
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => (p['payload'] as { source: string }).source === 'audit')).toBe(true);

    // Collection advanced to fetching.
    const statusUpdates = f.tx.collection.update.mock.calls.map(
      (c) => (c[0] as { data: { status?: string } }).data.status,
    );
    expect(statusUpdates).toContain('fetching');
  });

  it('records a permission exception when the connector is delegated-only', async () => {
    const f = fakeCtx();
    armAuditOnlyCollection(f);
    const { AuditRequiresOrganizationModeError } = await import('../audit.js');
    buildAuditConnectors.mockRejectedValue(
      new AuditRequiresOrganizationModeError('audit requires organization mode'),
    );

    await processCollectionDiscover(f.ctx, payload);

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'permission_denied', source: 'audit' }),
      }),
    );
    // The only source failed to enumerate -> collection fails.
    const statusUpdates = f.tx.collection.update.mock.calls.map(
      (c) => (c[0] as { data: { status?: string } }).data.status,
    );
    expect(statusUpdates).toContain('failed');
  });
});
