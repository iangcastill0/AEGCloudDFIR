import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLECTION,
  EVIDENCE,
  TENANT,
  fakeCtx,
  silentLog,
  type FakeCtx,
} from '../testing/fakes.js';
import { processParse } from './process-parse.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    kind: 'email',
    name: 'Msg.eml',
    mimeType: 'message/rfc822',
    size: 1024n,
    collectionId: COLLECTION,
    custodianId: null,
    providerItemId: 'p1',
    processingStatus: 'pending',
    emailMetadata: null,
    blob: {
      id: 'blob-1',
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
      storageClass: 'original',
    },
    ...overrides,
  });
}

function noSuchKey(): Error {
  const err = new Error('The specified key does not exist.') as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = 'NoSuchKey';
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

beforeEach(() => {
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
});

describe('processParse — missing evidence object', () => {
  it('records object_missing and stops, instead of throwing into BullMQ retries', async () => {
    // Parse is the primary reader of email bytes. With ClamAV off, scan never
    // opens the object, so a vanished .eml used to become a generic job failure
    // and never reached the exceptions ledger — the same silence PR #13 fixed
    // in extract/ocr/preview/scan.
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(noSuchKey());
    const loadParser = vi.fn();

    await expect(processParse(f.ctx, payload, { loadParser })).resolves.toBeUndefined();

    expect(loadParser).not.toHaveBeenCalled();
    const row = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { kind: string };
    };
    expect(row.data.kind).toBe('object_missing');
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: 'exception' }),
      }),
    );
    expect(silentLog.error).toHaveBeenCalledWith(
      expect.anything(),
      'evidence object is MISSING from object storage',
    );
  });

  it('still rethrows a read failure that is worth retrying', async () => {
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(new Error('socket hang up'));
    await expect(processParse(f.ctx, payload, { loadParser: vi.fn() })).rejects.toThrow(
      /socket hang up/,
    );
  });
});
