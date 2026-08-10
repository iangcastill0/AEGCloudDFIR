import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProductionError } from './errors.js';
import {
  assembleImageOnlyPdf,
  burnRedactions,
  validateNoTextLayer,
} from './redaction.js';

/** White 400x300 page with a black "text-ish" band in the middle. */
async function makePageImage(): Promise<Buffer> {
  const band = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect x="40" y="130" width="320" height="20" fill="#000000"/></svg>',
  );
  return sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
    .composite([{ input: band }])
    .png()
    .toBuffer();
}

async function pixelAt(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset] ?? -1, data[offset + 1] ?? -1, data[offset + 2] ?? -1];
}

describe('burnRedactions', () => {
  it('paints the redaction region opaque in the configured color', async () => {
    const page = await makePageImage();
    // Redact the right half of the black band with a red box.
    const burned = await burnRedactions(
      page,
      [{ x: 0.5, y: 0.4, w: 0.4, h: 0.2 }],
      { color: '#ff0000', label: '' },
    );
    // Inside the redaction: red, even where the black band used to be.
    expect(await pixelAt(burned, 250, 140)).toEqual([255, 0, 0]);
    expect(await pixelAt(burned, 300, 100 + 40)).toEqual([255, 0, 0]);
    // Outside the redaction: band still black on the left, background white above.
    expect(await pixelAt(burned, 100, 140)).toEqual([0, 0, 0]);
    expect(await pixelAt(burned, 100, 20)).toEqual([255, 255, 255]);
  });

  it('defaults to black and supports labels without breaking opacity at the edges', async () => {
    const page = await makePageImage();
    const burned = await burnRedactions(page, [{ x: 0.1, y: 0.1, w: 0.5, h: 0.3 }], {
      label: 'REDACTED',
    });
    // Corner of the redaction box (away from centered label glyphs) is black.
    expect(await pixelAt(burned, 45, 35)).toEqual([0, 0, 0]);
  });

  it('rejects rects outside 0..1 and bad colors', async () => {
    const page = await makePageImage();
    await expect(
      burnRedactions(page, [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }]),
    ).rejects.toThrow(ProductionError);
    await expect(
      burnRedactions(page, [{ x: 0, y: 0, w: 1.5, h: 0.5 }]),
    ).rejects.toThrow(ProductionError);
    await expect(
      burnRedactions(page, [{ x: 0, y: 0, w: 0.5, h: 0.5 }], { color: 'red' }),
    ).rejects.toThrow(ProductionError);
  });
});

describe('assembleImageOnlyPdf + validateNoTextLayer', () => {
  it('produces an image-only PDF with no extractable text layer', async () => {
    const page = await makePageImage();
    const burned = await burnRedactions(page, [{ x: 0.2, y: 0.4, w: 0.6, h: 0.2 }], {
      label: 'REDACTED',
    });
    const pdfBytes = await assembleImageOnlyPdf([
      { image: burned, format: 'png', dpi: 96 },
      { image: page, format: 'png', dpi: 96 },
    ]);
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(2);
    // 400px at 96dpi -> 300pt
    expect(Math.round(doc.getPage(0).getSize().width)).toBe(300);

    const validation = await validateNoTextLayer(pdfBytes);
    expect(validation).toEqual({ hasText: false, pagesWithText: [] });
  });

  it('detects a text layer in a PDF that has one', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([612, 792]); // page 1: empty
    const page2 = doc.addPage([612, 792]);
    page2.drawText('hidden but extractable text', { x: 72, y: 700, size: 12, font });
    const validation = await validateNoTextLayer(await doc.save());
    expect(validation.hasText).toBe(true);
    expect(validation.pagesWithText).toEqual([2]);
  });

  it('supports jpeg pages and rejects zero pages', async () => {
    const page = await makePageImage();
    const jpeg = await sharp(page).jpeg({ quality: 90 }).toBuffer();
    const pdfBytes = await assembleImageOnlyPdf([{ image: jpeg, format: 'jpeg' }]);
    expect((await validateNoTextLayer(pdfBytes)).hasText).toBe(false);
    await expect(assembleImageOnlyPdf([])).rejects.toThrow(ProductionError);
  });
});
