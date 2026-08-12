import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NonDownloadableError } from '@aeg-clouddfir/connectors';
import { QUEUES } from '../queues.js';
import {
  ACCOUNT,
  COLLECTION,
  CUSTODIAN,
  TENANT,
  createManyRows,
  fakeCtx,
  type FakeCtx,
} from '../testing/fakes.js';
import { processCollectionFetchItem } from './collection-fetch-item.js';

vi.mock('../connector-factory.js', () => ({
  buildConnectorsForAccount: vi.fn(),
  makeRateLimitObserver: vi.fn(() => () => undefined),
}));
const factory = await import('../connector-factory.js');
const buildConnectors = vi.mocked(factory.buildConnectorsForAccount);

const emailPayload = {
  tenantId: TENANT,
  collectionId: COLLECTION,
  custodianId: CUSTODIAN,
  source: 'email' as const,
  providerItemId: 'msg-1',
};

function arm(f: FakeCtx, itemState = 'discovered', attempts = 0): void {
  f.tx.collectionItem.findUnique.mockResolvedValue({
    id: 'ci-1',
    state: itemState,
    attempts,
    providerImmutableId: 'imm-1',
  });
  f.tx.collection.findUnique.mockResolvedValue({ status: 'fetching', connectorAccountId: ACCOUNT });
  f.tx.custodian.findUnique.mockResolvedValue({
    id: CUSTODIAN,
    externalId: 'ext-1',
    email: 'user@example.com',
  });
  f.tx.connectorAccount.findUnique.mockResolvedValue({ provider: 'microsoft' });
  f.tx.evidenceBlob.findUniqueOrThrow.mockResolvedValue({ id: 'blob-1' });
  f.tx.evidenceItem.create.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' });
}

function armEmailConnector(fetchMessage: ReturnType<typeof vi.fn>): void {
  buildConnectors.mockResolvedValue({
    provider: 'microsoft',
    mode: 'delegated',
    custodianRef: 'me',
    email: { fetchMessage, listMessages: vi.fn(), listMailFolders: vi.fn(), getMailDelta: vi.fn() },
    drive: {
      listDrives: vi.fn(),
      listFiles: vi.fn(),
      fetchContent: vi.fn(),
      getChangesDelta: vi.fn(),
    },
  } as never);
}

describe('processCollectionFetchItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early for already-preserved items without touching the store', async () => {
    const f = fakeCtx();
    arm(f, 'preserved');
    await processCollectionFetchItem(f.ctx, emailPayload);
    expect(f.store.stageStream).not.toHaveBeenCalled();
    expect(buildConnectors).not.toHaveBeenCalled();
    expect(f.tx.collectionItem.update).not.toHaveBeenCalled();
  });

  it('happy path: stage -> promote -> transactional bundle with audit and processing outbox', async () => {
    const f = fakeCtx();
    arm(f);
    armEmailConnector(
      vi.fn().mockResolvedValue({
        providerItemId: 'msg-1',
        rfc822: Buffer.from('From: a@x.com\r\n\r\nhi'),
        metadata: {
          subject: 'Hello',
          receivedAt: '2026-02-01T10:00:00Z',
          hasAttachments: false,
          bccRecipients: undefined,
        },
      }),
    );

    await processCollectionFetchItem(f.ctx, emailPayload);

    expect(f.store.stageStream).toHaveBeenCalledTimes(1);
    expect(f.store.promoteToOriginal).toHaveBeenCalledWith(
      TENANT,
      expect.stringContaining('/staging/'),
      { sha256: 'a'.repeat(64), size: 3 },
      { quarantine: false },
    );
    // evidence + metadata + state machine
    const evidenceData = (
      f.tx.evidenceItem.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(evidenceData['kind']).toBe('email');
    expect(evidenceData['name']).toBe('Hello');
    const metadataData = (
      f.tx.emailMetadata.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(metadataData['bccPresent']).toBe(false);
    expect(f.tx.collectionItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'preserved' }),
      }),
    );
    const audit = f.tx.auditEvent.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('evidence.acquired');

    const topics = createManyRows(f.tx.outboxEvent).map((r) => r['topic']);
    expect(topics).toContain(QUEUES.processParse);
    expect(topics).toContain(QUEUES.processScan);
    expect(topics).not.toContain(QUEUES.processExtract);
  });

  it('non-downloadable content becomes a skipped item + exception with no store calls', async () => {
    const f = fakeCtx();
    arm(f);
    const fetchContent = vi
      .fn()
      .mockRejectedValue(
        new NonDownloadableError('no native content', { kind: 'non_downloadable' }),
      );
    buildConnectors.mockResolvedValue({
      provider: 'microsoft',
      mode: 'delegated',
      custodianRef: 'me',
      email: {
        fetchMessage: vi.fn(),
        listMessages: vi.fn(),
        listMailFolders: vi.fn(),
        getMailDelta: vi.fn(),
      },
      drive: {
        listDrives: vi.fn(),
        listFiles: vi.fn(),
        fetchContent,
        getChangesDelta: vi.fn(),
      },
    } as never);

    await processCollectionFetchItem(f.ctx, {
      ...emailPayload,
      source: 'drive',
      providerItemId: 'file-1',
      entry: {
        providerItemId: 'file-1',
        name: 'report.docx',
        mimeType: 'application/msword',
        path: '/report.docx',
        checksums: {},
        isFolder: false,
        downloadable: false,
      },
    });

    expect(f.store.stageStream).not.toHaveBeenCalled();
    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'non_downloadable' }),
      }),
    );
    expect(f.tx.collectionItem.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'skipped' }) }),
    );
  });

  it('permanently fails on the 5th attempt without rethrowing', async () => {
    const f = fakeCtx();
    arm(f, 'failed', 4); // this run is attempt #5
    armEmailConnector(vi.fn().mockRejectedValue(new Error('HTTP 503 from provider')));

    await expect(processCollectionFetchItem(f.ctx, emailPayload)).resolves.toBeUndefined();

    expect(f.tx.collectionItem.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'api_error',
          detail: expect.objectContaining({ permanent: true }),
        }),
      }),
    );
  });

  it('rethrows transient errors before the attempt cap so BullMQ retries', async () => {
    const f = fakeCtx();
    arm(f, 'discovered', 0);
    armEmailConnector(vi.fn().mockRejectedValue(new Error('HTTP 503 from provider')));
    await expect(processCollectionFetchItem(f.ctx, emailPayload)).rejects.toThrow('503');
  });
});
