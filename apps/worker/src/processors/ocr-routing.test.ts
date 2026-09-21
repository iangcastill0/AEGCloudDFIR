import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE, TENANT, fakeCtx } from '../testing/fakes.js';
import { QUEUES } from '../queues.js';
import { ocrOutboxRows } from './process-extract.js';
import { processOcr, type OcrRunner } from './process-ocr.js';

describe('ocrOutboxRows routes OCR by cost class', () => {
  /**
   * One FIFO queue held both classes. A 2.7 MB `Aging Report.pdf` occupied a
   * slot for 33 minutes while ~90,000 sub-second image jobs waited behind it,
   * and measured throughput was 2.26 jobs/min. Routing is what keeps a long
   * PDF from blocking 90,000 images, and 90,000 images from blocking a PDF.
   */
  it('sends images to the image lane', () => {
    const rows = ocrOutboxRows(TENANT, EVIDENCE, 1, 'image/png', 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe(QUEUES.processOcrImage);
  });

  it('sends PDFs and converted documents to the document lane', () => {
    expect(ocrOutboxRows(TENANT, EVIDENCE, 1, 'application/pdf', 0)[0]?.topic).toBe(
      QUEUES.processOcr,
    );
    expect(ocrOutboxRows(TENANT, EVIDENCE, 1, 'application/msword', 2)[0]?.topic).toBe(
      QUEUES.processOcr,
    );
  });

  it('queues nothing at all for something that cannot be OCRed', () => {
    expect(ocrOutboxRows(TENANT, EVIDENCE, 1, 'text/csv', 0)).toEqual([]);
    expect(ocrOutboxRows(TENANT, EVIDENCE, 1, 'application/msword', 5_000)).toEqual([]);
  });

  /**
   * The dedup key must NOT encode the lane. An item is one piece of work
   * whichever queue runs it; a lane-specific key would let the same item be
   * OCRed twice the moment the routing rule changed.
   */
  it('uses the same dedup key on both lanes', () => {
    const image = ocrOutboxRows(TENANT, EVIDENCE, 3, 'image/png', 0)[0];
    const pdf = ocrOutboxRows(TENANT, EVIDENCE, 3, 'application/pdf', 0)[0];
    expect(image?.dedupKey).toBe(pdf?.dedupKey);
    expect(image?.dedupKey).toContain(EVIDENCE);
  });
});

function ocrCtx(maxPages: number): ReturnType<typeof fakeCtx> {
  const f = fakeCtx({ config: { CDFIR_MAX_OCR_PAGES: maxPages } });
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    mimeType: 'application/pdf',
    extension: 'pdf',
    collectionId: 'c0000000-0000-4000-8000-000000000001',
    custodianId: null,
    providerItemId: 'p1',
    blob: { objectKey: 'k', storageClass: 'original' },
    ocrPages: [],
    extractedTexts: [{ charCount: 0 }],
  });
  f.store.getStream.mockImplementation(() =>
    Promise.resolve(Readable.from(Buffer.from('%PDF-1.4'))),
  );
  return f;
}

describe('a truncated OCR says so', () => {
  /**
   * The cap used to be 2,000 pages and silent. Two problems: one document
   * could own an OCR slot for over half an hour, and an item that was read in
   * part looked exactly like one read in full. In a product whose failure mode
   * is "reports success, silently broken", a partial read must announce itself.
   *
   * 500 is not arbitrary — search-index.ts indexes at most 500 OCR pages, so
   * anything past that was rasterised, OCRed, and then thrown away.
   */
  function runner(pages: number): OcrRunner {
    return {
      tesseractVersion: vi.fn().mockResolvedValue('5.3.0'),
      pdfRasterAvailable: vi.fn().mockResolvedValue(true),
      // Honour the requested cap, so asking for maxPages+1 reveals whether a
      // page past the cap exists.
      pdfToImages: vi
        .fn()
        .mockImplementation((_pdf: Buffer, max: number) =>
          Promise.resolve(Array.from({ length: Math.min(pages, max) }, () => Buffer.from('p'))),
        ),
      ocrImage: vi.fn().mockResolvedValue({ text: 'x', confidence: 90 }),
      documentToPdf: vi.fn().mockResolvedValue(null),
    };
  }

  it('records where it stopped when the document is longer than the cap', async () => {
    const f = ocrCtx(3);
    await processOcr(
      f.ctx,
      { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 },
      { runner: runner(10) },
    );

    const update = f.tx.evidenceItem.update.mock.calls.at(-1)?.[0] as {
      data: { processingStatus: string; processingDetail: string };
    };
    expect(update.data.processingStatus).toBe('ocr_complete');
    expect(update.data.processingDetail).toContain('first 3 page(s)');
    expect(update.data.processingDetail).toMatch(/NOT in this record or in search/);
    // Only the pages within the cap are actually read.
    expect(f.tx.ocrPage.createMany).toHaveBeenCalledTimes(1);
  });

  it('leaves the note empty when the whole document was read', async () => {
    const f = ocrCtx(10);
    await processOcr(
      f.ctx,
      { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 },
      { runner: runner(2) },
    );

    const update = f.tx.evidenceItem.update.mock.calls.at(-1)?.[0] as {
      data: { processingDetail: string };
    };
    expect(update.data.processingDetail).toBe('');
  });
});
