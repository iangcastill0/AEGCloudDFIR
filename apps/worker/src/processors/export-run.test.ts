import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE, EXPORT_ID, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import { processExportRun, shouldStartNewArchive, type ArchiveWriterLike } from './export-run.js';

const GOOD_ID = EVIDENCE;
const BAD_ID = '99999999-9999-4999-8999-999999999999';
const GOOD_CONTENT = Buffer.from('hello export');
const GOOD_SHA = createHash('sha256').update(GOOD_CONTENT).digest('hex');

const payload = { tenantId: TENANT, exportId: EXPORT_ID };

function evidenceRow(id: string, sha256: string): Record<string, unknown> {
  return {
    id,
    kind: 'file',
    name: `${id.slice(0, 4)}.txt`,
    extension: 'txt',
    mimeType: 'text/plain',
    size: BigInt(GOOD_CONTENT.byteLength),
    sha256,
    custodianId: null,
    collectionId: null,
    sourcePath: '/x',
    sourceLabels: [],
    processingStatus: 'extracted',
    malwareStatus: 'clean',
    isApiExportDerivative: false,
    primaryDate: null,
    acquiredAt: new Date('2026-01-01T00:00:00Z'),
    blob: {
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${sha256}`,
      storageClass: 'original',
    },
    custodian: { email: 'user@example.com' },
    emailMetadata: null,
    participants: [],
    tagAssignments: [],
    childRelationships: [],
  };
}

function arm(f: FakeCtx): { writer: ArchiveWriterLike; append: ReturnType<typeof vi.fn> } {
  f.tx.export.findUnique.mockResolvedValue({
    id: EXPORT_ID,
    kind: 'native',
    status: 'queued',
    parameters: {
      selection: { kind: 'items', evidenceItemIds: [GOOD_ID, BAD_ID] },
      includeFamilies: false,
      archiveSplitMb: 2048,
    },
  });
  f.tx.evidenceItem.findMany.mockResolvedValue([
    evidenceRow(GOOD_ID, GOOD_SHA),
    evidenceRow(BAD_ID, 'f'.repeat(64)), // recorded hash will NOT match the bytes
  ]);
  f.store.getStream.mockImplementation(() => Promise.resolve(Readable.from(GOOD_CONTENT)));
  const append = vi.fn();
  const writer: ArchiveWriterLike = {
    append,
    finalize: vi.fn().mockResolvedValue({ entryCount: 2 }),
  };
  return { writer, append };
}

describe('shouldStartNewArchive', () => {
  it('splits only when the current part is non-empty and would overflow', () => {
    const split = 100;
    expect(shouldStartNewArchive(0, 500, split)).toBe(false); // oversized item, own part
    expect(shouldStartNewArchive(60, 30, split)).toBe(false);
    expect(shouldStartNewArchive(60, 50, split)).toBe(true);
    expect(shouldStartNewArchive(100, 1, split)).toBe(true);
  });
});

describe('processExportRun (native)', () => {
  it('marks a hash-mismatched item failed but completes the export as ready', async () => {
    const f = fakeCtx();
    const { writer } = arm(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writer });

    const upserts = f.tx.exportItem.upsert.mock.calls.map(
      (c) =>
        c[0] as {
          where: { exportId_evidenceItemId: { evidenceItemId: string } };
          create: Record<string, unknown>;
        },
    );
    const good = upserts.find((u) => u.where.exportId_evidenceItemId.evidenceItemId === GOOD_ID);
    const bad = upserts.find((u) => u.where.exportId_evidenceItemId.evidenceItemId === BAD_ID);
    expect(good?.create['state']).toBe('verified');
    expect(good?.create['verified']).toBe(true);
    expect(bad?.create['state']).toBe('failed');
    expect(String(bad?.create['error'])).toContain('sha256 mismatch');

    const finalUpdate = f.tx.export.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('ready');
    expect(finalUpdate.data['itemCount']).toBe(1);
    expect(String(finalUpdate.data['statusDetail'])).toContain('1 item(s) failed verification');

    const audit = f.tx.auditEvent.create.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data['action']).toBe('export.completed');
  });

  it('appends manifests, hashlist, exceptions, and README to the archive', async () => {
    const f = fakeCtx();
    const { writer, append } = arm(f);
    await processExportRun(f.ctx, payload, { createArchive: () => writer });
    const paths = append.mock.calls.map((c) => c[0] as string);
    for (const expected of [
      'manifest.json',
      'manifest.csv',
      'hashlist.txt',
      'exceptions.csv',
      'README.txt',
    ]) {
      expect(paths).toContain(expected);
    }
    // Item entries are grouped under custodian directories.
    expect(paths.some((p) => p.startsWith('custodian/user@example.com/'))).toBe(true);
  });

  it('fails the export record on systemic errors instead of throwing', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.export.findUnique.mockResolvedValue({
      id: EXPORT_ID,
      kind: 'native',
      status: 'queued',
      parameters: { selection: { kind: 'nonsense' } },
    });
    await expect(processExportRun(f.ctx, payload)).resolves.toBeUndefined();
    const finalUpdate = f.tx.export.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('failed');
  });

  it('returns without work for already-finished exports', async () => {
    const f = fakeCtx();
    f.tx.export.findUnique.mockResolvedValue({
      id: EXPORT_ID,
      kind: 'native',
      status: 'ready',
      parameters: {},
    });
    await processExportRun(f.ctx, payload);
    expect(f.tx.export.update).not.toHaveBeenCalled();
  });
});
