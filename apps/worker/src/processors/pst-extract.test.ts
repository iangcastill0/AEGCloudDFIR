import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../queues.js';
import {
  COLLECTION,
  CUSTODIAN,
  EVIDENCE,
  TENANT,
  createManyRows,
  fakeCtx,
  type FakeCtx,
} from '../testing/fakes.js';
import { processPstExtract } from './pst-extract.js';
import type { PstArchive, PstMessageData, PstReader } from './pst-reader.js';

const payload = {
  tenantId: TENANT,
  collectionId: COLLECTION,
  custodianId: CUSTODIAN,
  evidenceItemId: EVIDENCE,
};

function message(overrides: Partial<PstMessageData> = {}): PstMessageData {
  return {
    descriptorNodeId: '2097188',
    subject: 'Board minutes',
    senderName: 'Avery Chen',
    senderEmailAddress: 'avery.chen@example.com',
    transportMessageHeaders: '',
    internetMessageId: '<original-1@example.com>',
    displayTo: 'Jordan Lee',
    displayCc: '',
    displayBcc: '',
    recipients: [{ kind: 'to', name: 'Jordan Lee', address: 'jordan.lee@example.com' }],
    bodyPlain: 'minutes attached',
    bodyHtml: '',
    clientSubmitTime: new Date('2026-01-15T09:00:00Z'),
    messageDeliveryTime: new Date('2026-01-15T09:00:05Z'),
    attachments: [],
    oversizedAttachments: [],
    ...overrides,
  };
}

function fakeReader(
  messages: { msg: PstMessageData; folderPath: string }[],
  openError?: Error,
): { reader: PstReader; closed: () => boolean } {
  let closed = false;
  const archive: PstArchive = {
    messageStoreDisplayName: 'Demo mailbox',
    async walk(cb) {
      for (const entry of messages) {
        await cb(entry.msg, entry.folderPath);
      }
      return { count: messages.length };
    },
    close() {
      closed = true;
    },
  };
  return {
    reader: {
      open(): PstArchive {
        if (openError) throw openError;
        return archive;
      },
    },
    closed: () => closed,
  };
}

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    kind: 'container',
    name: 'Mailbox.pst',
    sha256: 'c'.repeat(64),
    blob: {
      objectKey: `tenants/${TENANT}/originals/sha256/cc/${'c'.repeat(64)}`,
      storageClass: 'original',
    },
    ...overrides,
  });
  f.tx.collection.findUnique.mockResolvedValue({ status: 'fetching' });
  f.tx.collectionItem.findUnique.mockResolvedValue({ id: 'ci-container', state: 'preserved' });
  f.tx.evidenceRelationship.count.mockResolvedValue(0);
  f.tx.collectionItem.findMany.mockResolvedValue([]);
  f.tx.evidenceItem.create.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999991' });
  f.store.getStream.mockResolvedValue(Readable.from([Buffer.from('pst container bytes')]));
}

describe('processPstExtract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconstructs each message: staged eml, labeled evidence, relationship, outbox', async () => {
    const f = fakeCtx();
    arm(f);
    const { reader, closed } = fakeReader([
      { msg: message(), folderPath: 'Inbox' },
      { msg: message({ descriptorNodeId: '2097224', subject: '' }), folderPath: 'Inbox/Sub' },
    ]);

    await processPstExtract(f.ctx, payload, { reader });

    // One synthesized .eml per message, streamed through staging + promote.
    expect(f.store.stageStream).toHaveBeenCalledTimes(2);
    expect(f.store.promoteToOriginal).toHaveBeenCalledTimes(2);

    // Extracted messages are reconstructions — labeled, never provider-native.
    const evidenceRows = f.tx.evidenceItem.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(evidenceRows).toHaveLength(2);
    for (const row of evidenceRows) {
      expect(row.kind).toBe('email');
      expect(row.provider).toBe('upload');
      expect(row.processingDetail).toBe('extracted-from-pst');
      expect(row.extension).toBe('eml');
    }
    expect(evidenceRows[0]?.providerItemId).toBe(`pst:${EVIDENCE}:2097188`);
    expect(evidenceRows[0]?.sourcePath).toBe('Mailbox.pst/Inbox');
    expect(evidenceRows[1]?.name).toBe('(no subject)');

    // container_member relationship back to the preserved container.
    const relRows = f.tx.evidenceRelationship.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(relRows).toHaveLength(2);
    expect(relRows[0]).toMatchObject({
      parentId: EVIDENCE,
      kind: 'container_member',
      detail: 'Inbox',
    });

    // Per-message collection items land preserved.
    const upserts = f.tx.collectionItem.upsert.mock.calls.map(
      (c) => (c[0] as { create: Record<string, unknown> }).create,
    );
    expect(upserts[0]).toMatchObject({ state: 'preserved', source: 'email' });

    // Standard pipeline stages fan out per message + container close-out rows.
    const topics = createManyRows(f.tx.outboxEvent).map((r) => r.topic);
    expect(topics.filter((t) => t === QUEUES.processParse)).toHaveLength(2);
    expect(topics.filter((t) => t === QUEUES.processScan)).toHaveLength(2);
    expect(topics.filter((t) => t === QUEUES.searchIndex)).toHaveLength(3); // 2 messages + container
    expect(topics).toContain(QUEUES.collectionFinalize);

    // Container closes out processed / extracted; audit trail written.
    expect(f.tx.collectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'processed' }) }),
    );
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processingStatus: 'extracted' } }),
    );
    const auditActions = f.tx.auditEvent.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data.action,
    );
    expect(auditActions.filter((a) => a === 'evidence.extracted_from_container')).toHaveLength(2);
    expect(auditActions).toContain('evidence.container_extraction_completed');
    expect(closed()).toBe(true);
  });

  it('is idempotent: completed containers are not re-extracted', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.evidenceRelationship.count.mockResolvedValue(2);
    f.tx.collectionItem.findUnique.mockResolvedValue({ id: 'ci-container', state: 'processed' });
    const { reader } = fakeReader([{ msg: message(), folderPath: 'Inbox' }]);

    await processPstExtract(f.ctx, payload, { reader });

    expect(f.store.getStream).not.toHaveBeenCalled();
    expect(f.store.stageStream).not.toHaveBeenCalled();
    expect(f.tx.evidenceItem.create).not.toHaveBeenCalled();
  });

  it('skips messages already preserved by a previous partial run', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.collectionItem.findMany.mockResolvedValue([
      { providerItemId: `pst:${EVIDENCE}:2097188`, state: 'preserved' },
    ]);
    const { reader } = fakeReader([
      { msg: message(), folderPath: 'Inbox' },
      { msg: message({ descriptorNodeId: '2097224' }), folderPath: 'Inbox' },
    ]);

    await processPstExtract(f.ctx, payload, { reader });

    expect(f.store.stageStream).toHaveBeenCalledTimes(1);
    expect(f.tx.evidenceItem.create).toHaveBeenCalledTimes(1);
  });

  it('encrypted containers become encrypted_item exceptions, never brute-forced', async () => {
    const f = fakeCtx();
    arm(f);
    const { reader } = fakeReader([], new Error('PSTFile::open PST is encrypted'));

    await expect(processPstExtract(f.ctx, payload, { reader })).resolves.toBeUndefined();

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'encrypted_item' }),
      }),
    );
    expect(f.tx.collectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'skipped' }) }),
    );
    expect(f.store.stageStream).not.toHaveBeenCalled();
    // Finalize still gets nudged so the collection can close out honestly.
    const topics = createManyRows(f.tx.outboxEvent).map((r) => r.topic);
    expect(topics).toContain(QUEUES.collectionFinalize);
  });

  it('corrupt containers fail permanently with a corrupt_item exception (no rethrow)', async () => {
    const f = fakeCtx();
    arm(f);
    const { reader } = fakeReader([], new Error('PSTFile::open Unrecognised PST File version: 99'));

    await expect(processPstExtract(f.ctx, payload, { reader })).resolves.toBeUndefined();

    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'corrupt_item' }),
      }),
    );
    expect(f.tx.collectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
  });

  it('stops at the message cap with an honest unsupported_item exception', async () => {
    const f = fakeCtx({ config: { CDFIR_PST_MAX_MESSAGES: 1 } });
    arm(f);
    const { reader } = fakeReader([
      { msg: message(), folderPath: 'Inbox' },
      { msg: message({ descriptorNodeId: '2097224' }), folderPath: 'Inbox' },
    ]);

    await processPstExtract(f.ctx, payload, { reader });

    expect(f.tx.evidenceItem.create).toHaveBeenCalledTimes(1);
    const exceptions = f.tx.collectionException.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(exceptions.some((e) => e.kind === 'unsupported_item')).toBe(true);
    const capMessage = exceptions.find((e) => e.kind === 'unsupported_item')?.message as string;
    expect(capMessage).toContain('NOT extracted');
    // The container still closes out; what WAS extracted stays preserved.
    expect(f.tx.collectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'processed' }) }),
    );
  });

  it('records oversized attachments as exceptions while preserving the message', async () => {
    const f = fakeCtx();
    arm(f);
    const { reader } = fakeReader([
      { msg: message({ oversizedAttachments: ['huge.iso'] }), folderPath: 'Inbox' },
    ]);

    await processPstExtract(f.ctx, payload, { reader });

    expect(f.tx.evidenceItem.create).toHaveBeenCalledTimes(1);
    expect(f.tx.collectionException.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'unsupported_item',
          message: expect.stringContaining('huge.iso'),
        }),
      }),
    );
  });
});
