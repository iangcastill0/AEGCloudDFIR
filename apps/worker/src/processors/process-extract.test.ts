import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLECTION,
  EVIDENCE,
  TENANT,
  fakeCtx,
  silentLog,
  type FakeCtx,
} from '../testing/fakes.js';
import { processExtract } from './process-extract.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    kind: 'file',
    name: 'contract.pdf',
    mimeType: 'application/pdf',
    size: 1024n,
    collectionId: COLLECTION,
    custodianId: null,
    providerItemId: 'p1',
    extractedTexts: [],
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

describe('processExtract — missing evidence object', () => {
  it('records object_missing and stops, instead of throwing into eight BullMQ retries', async () => {
    // getStream failures other than PayloadTooLargeError were rethrown, so a
    // key that will never come back was retried with backoff and finished as a
    // generic job failure. Nothing in the product said the bytes were gone.
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(noSuchKey());
    const fetchImpl = vi.fn();

    await expect(processExtract(f.ctx, payload, { fetchImpl })).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
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
    await expect(processExtract(f.ctx, payload, { fetchImpl: vi.fn() })).rejects.toThrow(
      'socket hang up',
    );
  });
});
