import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLECTION,
  EVIDENCE,
  TENANT,
  fakeCtx,
  silentLog,
  type FakeCtx,
} from '../testing/fakes.js';
import { processOcr, type OcrRunner } from './process-ocr.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    name: 'scan.png',
    mimeType: 'image/png',
    extension: 'png',
    collectionId: COLLECTION,
    custodianId: null,
    providerItemId: 'p1',
    ocrPages: [],
    extractedTexts: [],
    blob: {
      id: 'blob-1',
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
      storageClass: 'original',
    },
    ...overrides,
  });
}

function runner(): OcrRunner {
  return {
    tesseractVersion: vi.fn().mockResolvedValue('5.0'),
    pdfRasterAvailable: vi.fn().mockResolvedValue(true),
    ocrImage: vi.fn().mockResolvedValue({ text: 'words', confidence: 90 }),
    pdfToImages: vi.fn().mockResolvedValue([]),
    documentToPdf: vi.fn().mockResolvedValue(null),
  };
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

describe('processOcr — missing evidence object', () => {
  it('records object_missing instead of throwing the job', async () => {
    // This read was not inside a try at all, so an absent object left the
    // processor as an unhandled failure and looked like an OCR problem.
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(noSuchKey());

    await expect(processOcr(f.ctx, payload, { runner: runner() })).resolves.toBeUndefined();

    const row = f.tx.collectionException.create.mock.calls[0]?.[0] as { data: { kind: string } };
    expect(row.data.kind).toBe('object_missing');
    expect(silentLog.error).toHaveBeenCalledWith(
      expect.anything(),
      'evidence object is MISSING from object storage',
    );
  });

  it('still rethrows a read failure that is worth retrying', async () => {
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(new Error('socket hang up'));
    await expect(processOcr(f.ctx, payload, { runner: runner() })).rejects.toThrow(
      'socket hang up',
    );
  });
});
