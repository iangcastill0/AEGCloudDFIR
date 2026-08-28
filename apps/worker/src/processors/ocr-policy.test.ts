import { describe, expect, it } from 'vitest';
import { LOW_TEXT_THRESHOLD, ocrDecision } from './ocr-policy';

describe('ocrDecision', () => {
  it('always OCRs an image, whatever the extractor produced', () => {
    // Tika can return incidental text for an image (EXIF, embedded captions).
    // That is not the content, so the pixels still have to be read.
    expect(ocrDecision({ mimeType: 'image/png', extractedChars: 0 }).run).toBe(true);
    expect(ocrDecision({ mimeType: 'image/jpeg', extractedChars: 5000 }).run).toBe(true);
    expect(ocrDecision({ mimeType: 'image/tiff', extractedChars: 0 }).run).toBe(true);
  });

  it('always OCRs a PDF, because a text layer can cover only part of a scan', () => {
    expect(ocrDecision({ mimeType: 'application/pdf', extractedChars: 20_000 }).run).toBe(true);
  });

  it('OCRs an Office document that yielded almost no text', () => {
    // Real staging data: 2 of 10 .docx attachments extract to nothing, because
    // the "document" is a photo of a page. Today they are silently unsearchable.
    const decision = ocrDecision({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractedChars: 0,
    });
    expect(decision.run).toBe(true);
    expect(decision.convertFirst).toBe(true);
  });

  it('leaves an Office document alone when it has real text', () => {
    // Converting and rasterising a 200-page contract that already extracted
    // cleanly is wasted minutes on every collection.
    expect(
      ocrDecision({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedChars: 25_000,
      }).run,
    ).toBe(false);
  });

  it('treats the threshold as "almost nothing", not "empty"', () => {
    // A scanned page often yields a stray header or a filename from the
    // container, so requiring exactly zero would miss most of them.
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(ocrDecision({ mimeType: mime, extractedChars: LOW_TEXT_THRESHOLD - 1 }).run).toBe(true);
    expect(ocrDecision({ mimeType: mime, extractedChars: LOW_TEXT_THRESHOLD + 1 }).run).toBe(false);
  });

  it('does not try to OCR things no tool here can read', () => {
    // Tesseract reads pixels; pdftoppm reads PDFs; LibreOffice converts
    // documents. A zip, a calendar file or an unknown blob is none of those, and
    // pretending otherwise burns a worker slot per item to produce nothing.
    for (const mimeType of [
      'application/zip',
      'application/x-zip-compressed',
      'text/calendar',
      'application/ics',
      'text/csv',
      'application/octet-stream',
      'video/mp4',
    ]) {
      expect(ocrDecision({ mimeType, extractedChars: 0 }).run, mimeType).toBe(false);
    }
  });

  it('says why, so an exception ledger can record the reason', () => {
    expect(ocrDecision({ mimeType: 'image/png', extractedChars: 0 }).reason).toBe('image');
    expect(ocrDecision({ mimeType: 'application/pdf', extractedChars: 0 }).reason).toBe('pdf');
    expect(ocrDecision({ mimeType: 'application/msword', extractedChars: 2 }).reason).toBe(
      'document-without-text',
    );
    expect(ocrDecision({ mimeType: 'text/csv', extractedChars: 0 }).reason).toBe('not-ocrable');
  });

  it('ignores parameters on the media type', () => {
    // Real headers carry charset and boundary parameters.
    expect(ocrDecision({ mimeType: 'image/png; charset=binary', extractedChars: 0 }).run).toBe(
      true,
    );
    expect(ocrDecision({ mimeType: 'APPLICATION/PDF', extractedChars: 0 }).run).toBe(true);
  });
});
