import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { renderPlaceholderPdf } from './placeholder.js';

async function extractAllText(pdfBytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ('str' in item) parts.push(item.str);
      }
    }
    return parts.join(' ');
  } finally {
    await task.destroy();
  }
}

describe('renderPlaceholderPdf', () => {
  it('renders a single page containing the reason, ids, and metadata', async () => {
    const pdfBytes = await renderPlaceholderPdf({
      reason: 'This document could not be converted to an image format (unsupported file type).',
      evidenceId: 'cdfir-1234',
      batesNumber: 'ABC00000042',
      metadata: { FileName: 'database.mdb', MIME: 'application/x-msaccess' },
    });
    const text = await extractAllText(pdfBytes);
    expect(text).toContain('DOCUMENT PLACEHOLDER');
    expect(text).toContain('could not be converted to an image format');
    expect(text).toContain('cdfir-1234');
    expect(text).toContain('ABC00000042');
    expect(text).toContain('database.mdb');
    expect(text).toContain('application/x-msaccess');
  });

  it('wraps long reasons instead of overflowing the page', async () => {
    const longReason = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const pdfBytes = await renderPlaceholderPdf({
      reason: longReason,
      evidenceId: 'cdfir-long',
      batesNumber: 'ABC00000001',
    });
    const text = await extractAllText(pdfBytes);
    expect(text).toContain('word0');
    expect(text).toContain('word39');
  });
});
