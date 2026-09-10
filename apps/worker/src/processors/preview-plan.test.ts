import { describe, expect, it } from 'vitest';
import { previewPlan } from './preview-plan.js';

describe('previewPlan', () => {
  /**
   * Counts are from the real 43,379-item matter that prompted this: 759 PNG,
   * 184 PDF, 154 DOCX, 145 JPEG, 33 calendar, 17 text, 12 CSV, 18 zip/7z,
   * 9 XLSX, 5 GIF, 4 icon, 2 video. Every one of them previewed as
   * "No safe preview is available".
   */
  it('serves raster images as collected, without re-encoding', () => {
    // Fidelity matters here: a reviewer should see the pixels that were
    // collected, not a recompression of them.
    for (const mime of ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/tiff']) {
      expect(previewPlan(mime).action).toBe('image');
    }
  });

  it('rasterises PDFs rather than embedding them', () => {
    // Deliberate: this avoids running a PDF renderer over evidence inside the
    // reviewer's browser.
    expect(previewPlan('application/pdf').action).toBe('rasterize');
  });

  it('sends Office documents through LibreOffice first', () => {
    const docx = previewPlan(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(docx.action).toBe('convert-then-rasterize');
    // soffice picks its import filter from the file name, not by sniffing.
    expect(docx.extension).toBe('docx');
    expect(
      previewPlan('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').extension,
    ).toBe('xlsx');
    expect(previewPlan('application/msword').extension).toBe('doc');
  });

  it('NEVER serves SVG as raw bytes', () => {
    // An SVG is XML that can carry script. In an <img> tag it is inert, but a
    // presigned URL opened directly in a tab is not — so it is rendered
    // through LibreOffice, which drops the script.
    const svg = previewPlan('image/svg+xml');
    expect(svg.action).not.toBe('image');
    expect(svg.action).toBe('convert-then-rasterize');
  });

  it('never serves HTML as raw bytes either', () => {
    expect(previewPlan('text/html').action).toBe('convert-then-rasterize');
    expect(previewPlan('application/xhtml+xml').action).toBe('convert-then-rasterize');
  });

  it('shows text formats as text', () => {
    for (const mime of ['text/plain', 'text/csv', 'text/calendar', 'application/json']) {
      expect(previewPlan(mime).action).toBe('text');
    }
  });

  it('tolerates a charset parameter on the mime type', () => {
    expect(previewPlan('text/plain; charset=utf-8').action).toBe('text');
    expect(previewPlan('IMAGE/PNG').action).toBe('image');
  });

  it('falls back to the file name when the provider did not look', () => {
    // application/octet-stream is what a provider sends when it gave up. The
    // extension usually still tells the truth.
    expect(previewPlan('application/octet-stream', 'report.pdf').action).toBe('rasterize');
    expect(previewPlan('application/octet-stream', 'photo.JPG').action).toBe('image');
    expect(previewPlan('application/octet-stream', 'memo.docx').action).toBe(
      'convert-then-rasterize',
    );
    expect(previewPlan('', 'notes.txt').action).toBe('text');
  });

  it('explains itself when there is no preview, naming the type', () => {
    // "No safe preview is available" told a reviewer nothing. Every refusal
    // now says what the file is and that the native bytes exist.
    const zip = previewPlan('application/x-zip-compressed');
    expect(zip.action).toBe('none');
    expect(zip.reason).toContain('ZIP');
    expect(zip.reason).toContain('native');

    const video = previewPlan('video/quicktime');
    expect(video.action).toBe('none');
    expect(video.reason).toContain('video');

    const unknown = previewPlan('application/x-made-up');
    expect(unknown.action).toBe('none');
    expect(unknown.reason).toContain('application/x-made-up');
    expect(unknown.reason).toContain('collected');
  });

  it('never returns a blank reason when it refuses', () => {
    for (const mime of ['application/zip', 'video/mp4', 'audio/mpeg', 'application/x-nonsense']) {
      const p = previewPlan(mime);
      if (p.action === 'none') expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it('gives an extension for everything it sends to LibreOffice', () => {
    // A missing extension makes soffice guess, and it guesses badly — the
    // documented failure is a Publisher file importing into Draw and writing
    // no output while reporting success.
    for (const mime of [
      'application/msword',
      'application/vnd.visio',
      'application/rtf',
      'image/svg+xml',
      'text/html',
    ]) {
      const p = previewPlan(mime);
      expect(p.action).toBe('convert-then-rasterize');
      expect(p.extension).toBeTruthy();
    }
  });
});
