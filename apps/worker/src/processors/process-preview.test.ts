import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import type { OcrRunner } from './process-ocr.js';
import { processPreview } from './process-preview.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    name: 'thing.png',
    mimeType: 'image/png',
    collectionId: 'c1',
    custodianId: null,
    providerItemId: 'p1',
    previews: [],
    blob: {
      id: 'blob-1',
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
      storageClass: 'original',
    },
    ...overrides,
  });
  f.store.getStream.mockResolvedValue(Readable.from(Buffer.from('IMAGEBYTES')));
  f.store.putDerivative.mockImplementation((_t, _e, _ty, _v, filename: string) =>
    Promise.resolve({
      objectKey: `tenants/${TENANT}/derivatives/${filename}`,
      sha256: 'x',
      size: 1,
    }),
  );
}

function runner(over: Partial<OcrRunner> = {}): OcrRunner {
  return {
    tesseractVersion: vi.fn().mockResolvedValue('5.0'),
    pdfRasterAvailable: vi.fn().mockResolvedValue(true),
    ocrImage: vi.fn(),
    pdfToImages: vi.fn().mockResolvedValue([Buffer.from('p1'), Buffer.from('p2')]),
    documentToPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF')),
    ...over,
  } as unknown as OcrRunner;
}

/** The Preview row a run produced, or undefined. */
function written(f: FakeCtx): Record<string, unknown> | undefined {
  const call = f.tx.preview.upsert.mock.calls[0]?.[0] as
    { create: Record<string, unknown> } | undefined;
  return call?.create;
}

describe('processPreview', () => {
  it('writes an image preview from the collected bytes, un-re-encoded', async () => {
    // Fidelity: a reviewer should see the pixels that were collected.
    const f = fakeCtx();
    arm(f);
    await processPreview(f.ctx, payload, { runner: runner() });
    expect(written(f)).toMatchObject({ kind: 'thumbnail', mimeType: 'image/png', pageCount: 1 });
    const body = f.store.putDerivative.mock.calls[0]?.[5] as Buffer;
    expect(body.toString()).toBe('IMAGEBYTES');
  });

  it('rasterises a PDF to one object per page and records the count', async () => {
    const f = fakeCtx();
    arm(f, { mimeType: 'application/pdf', name: 'memo.pdf' });
    await processPreview(f.ctx, payload, { runner: runner() });
    expect(f.store.putDerivative).toHaveBeenCalledTimes(2);
    expect(f.store.putDerivative.mock.calls[0]?.[4]).toBe('preview-page001.png');
    expect(f.store.putDerivative.mock.calls[1]?.[4]).toBe('preview-page002.png');
    expect(written(f)).toMatchObject({ kind: 'page_images', pageCount: 2 });
  });

  it('sends an Office document through LibreOffice before rasterising', async () => {
    const f = fakeCtx();
    const r = runner();
    arm(f, {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'memo.docx',
    });
    await processPreview(f.ctx, payload, { runner: r });
    expect(r.documentToPdf).toHaveBeenCalledWith(expect.anything(), 'docx');
    expect(written(f)).toMatchObject({ kind: 'page_images' });
  });

  it('never renders a quarantined file', async () => {
    // The native download gates infected items deliberately; a preview must
    // not quietly route around that gate.
    const f = fakeCtx();
    arm(f, { blob: { id: 'b', objectKey: 'k', storageClass: 'quarantine' } });
    await processPreview(f.ctx, payload, { runner: runner() });
    expect(f.tx.preview.upsert).not.toHaveBeenCalled();
    expect(f.store.getStream).not.toHaveBeenCalled();
  });

  it('records WHY when a type cannot be previewed', async () => {
    // "No safe preview is available" told a reviewer nothing about whether
    // the file was broken, unsupported, or never collected.
    const f = fakeCtx();
    arm(f, { mimeType: 'application/x-zip-compressed', name: 'bundle.zip' });
    await processPreview(f.ctx, payload, { runner: runner() });
    expect(f.tx.preview.upsert).not.toHaveBeenCalled();
    expect(f.tx.collectionException.create).toHaveBeenCalled();
    const arg = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { message: string };
    };
    expect(arg.data.message).toContain('ZIP');
  });

  it('is honest when LibreOffice produces nothing', async () => {
    // soffice reports success on some documents while writing no file at all.
    // Treating that as "empty" makes a missing preview look like a blank page.
    const f = fakeCtx();
    arm(f, { mimeType: 'application/msword', name: 'old.doc' });
    await processPreview(f.ctx, payload, {
      runner: runner({ documentToPdf: vi.fn().mockResolvedValue(null) }),
    });
    expect(f.tx.preview.upsert).not.toHaveBeenCalled();
    const arg = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { message: string };
    };
    expect(arg.data.message).toContain('could not be converted');
  });

  it('does not overwrite a preview the email parser already wrote', async () => {
    const f = fakeCtx();
    arm(f, { previews: [{ id: 'existing' }] });
    await processPreview(f.ctx, payload, { runner: runner() });
    expect(f.store.getStream).not.toHaveBeenCalled();
  });

  it('never fails the job when generation blows up', async () => {
    // A preview is a convenience. Losing one must not fail the pipeline or
    // endanger the evidence behind it.
    const f = fakeCtx();
    arm(f, { mimeType: 'application/pdf', name: 'x.pdf' });
    await expect(
      processPreview(f.ctx, payload, {
        runner: runner({ pdfToImages: vi.fn().mockRejectedValue(new Error('boom')) }),
      }),
    ).resolves.toBeUndefined();
    const arg = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { message: string };
    };
    expect(arg.data.message).toContain('Preview generation failed');
  });

  it('a missing evidence object is not filed as a preview problem', async () => {
    // This stage wrote "The stored file could not be read" under kind 'other'
    // for a slow network AND for evidence that no longer exists. One of those
    // is a preview inconvenience; the other means the bytes are gone.
    const f = fakeCtx();
    arm(f);
    const gone = new Error('The specified key does not exist.') as Error & {
      $metadata: { httpStatusCode: number };
    };
    gone.name = 'NoSuchKey';
    gone.$metadata = { httpStatusCode: 404 };
    f.store.getStream.mockRejectedValue(gone);

    await expect(processPreview(f.ctx, payload, { runner: runner() })).resolves.toBeUndefined();

    const row = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { kind: string; message: string };
    };
    expect(row.data.kind).toBe('object_missing');
    expect(row.data.message).not.toContain('no preview');
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: 'exception' }),
      }),
    );
  });

  it('a read failure that is NOT a missing key stays an ordinary preview note', async () => {
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(new Error('socket hang up'));
    await processPreview(f.ctx, payload, { runner: runner() });
    const row = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { kind: string; message: string };
    };
    expect(row.data.kind).toBe('other');
    expect(row.data.message).toContain('could not be read');
  });

  it('says so when the page renderer is missing rather than silently skipping', async () => {
    const f = fakeCtx();
    arm(f, { mimeType: 'application/pdf', name: 'x.pdf' });
    await processPreview(f.ctx, payload, {
      runner: runner({ pdfRasterAvailable: vi.fn().mockResolvedValue(false) }),
    });
    const arg = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { message: string };
    };
    expect(arg.data.message).toContain('renderer is unavailable');
  });
});
