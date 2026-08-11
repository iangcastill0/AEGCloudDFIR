import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { ProductionError } from './errors.js';

/** Redaction rectangle in normalized page coordinates (0..1, origin top-left). */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BurnRedactionOptions {
  /** Fill color, hex '#rrggbb'. Default black. */
  color?: string;
  /** Optional label drawn centered in each redaction box. */
  label?: string;
  /** Label color, hex '#rrggbb'. Default white. */
  labelColor?: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function assertHexColor(value: string, what: string): void {
  if (!HEX_COLOR.test(value)) {
    throw new ProductionError(`${what} must be a #rrggbb hex color, got "${value}"`);
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Burn opaque redaction rectangles (plus optional labels) into a rasterized
 * page image. Input and output are flattened PNG buffers — the result carries
 * no removable layers.
 */
export async function burnRedactions(
  pageImagePng: Buffer,
  rects: readonly NormalizedRect[],
  options: BurnRedactionOptions = {},
): Promise<Buffer> {
  const color = options.color ?? '#000000';
  const labelColor = options.labelColor ?? '#ffffff';
  const label = options.label ?? '';
  assertHexColor(color, 'redaction color');
  assertHexColor(labelColor, 'label color');

  const metadata = await sharp(pageImagePng).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined) {
    throw new ProductionError('could not read page image dimensions');
  }

  if (rects.length === 0) {
    return sharp(pageImagePng).flatten({ background: '#ffffff' }).png().toBuffer();
  }

  const shapes: string[] = [];
  for (const rect of rects) {
    for (const [name, v] of Object.entries(rect)) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new ProductionError(
          `redaction rect ${name}=${v} is outside the normalized 0..1 range`,
        );
      }
    }
    const px = Math.floor(rect.x * width);
    const py = Math.floor(rect.y * height);
    const pw = Math.max(1, Math.ceil(rect.w * width));
    const ph = Math.max(1, Math.ceil(rect.h * height));
    shapes.push(`<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="${color}"/>`);
    if (label.length > 0) {
      const fontSize = Math.max(6, Math.min(ph * 0.6, (pw / Math.max(label.length, 1)) * 1.6));
      const cx = px + pw / 2;
      const cy = py + ph / 2 + fontSize * 0.35;
      shapes.push(
        `<text x="${cx}" y="${cy}" font-family="sans-serif" font-size="${fontSize}" ` +
          `fill="${labelColor}" text-anchor="middle">${escapeXml(label)}</text>`,
      );
    }
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`,
  );

  return sharp(pageImagePng)
    .composite([{ input: svg, left: 0, top: 0 }])
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

export interface ImagePdfPage {
  image: Buffer | Uint8Array;
  format: 'png' | 'jpeg';
  /** Pixels-per-inch used to size the PDF page. Default 72 (1px = 1pt). */
  dpi?: number;
}

/**
 * Assemble flattened page images into an image-only PDF. The output contains
 * no text layer, so hidden text cannot leak from redacted documents.
 */
export async function assembleImageOnlyPdf(pages: readonly ImagePdfPage[]): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new ProductionError('cannot assemble a PDF with zero pages');
  }
  const doc = await PDFDocument.create();
  for (const pageSpec of pages) {
    const dpi = pageSpec.dpi ?? 72;
    if (!Number.isFinite(dpi) || dpi <= 0) {
      throw new ProductionError(`dpi must be positive, got ${dpi}`);
    }
    const embedded =
      pageSpec.format === 'png'
        ? await doc.embedPng(pageSpec.image)
        : await doc.embedJpg(pageSpec.image);
    const scale = 72 / dpi;
    const pageWidth = embedded.width * scale;
    const pageHeight = embedded.height * scale;
    const page = doc.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  }
  return doc.save();
}

export interface TextLayerValidation {
  hasText: boolean;
  /** 1-based page numbers that contain extractable text. */
  pagesWithText: number[];
}

/**
 * Verify that a PDF carries no extractable text layer. Used as the leakage
 * gate for final-redacted output: image-only PDFs must return hasText:false.
 */
export async function validateNoTextLayer(pdfBytes: Uint8Array): Promise<TextLayerValidation> {
  // pdfjs-dist is only needed for validation paths; import lazily so the
  // hot production code paths do not pay for it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs takes ownership of (and may detach) the buffer it is given — pass a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
  });
  const pagesWithText: number[] = [];
  try {
    const doc = await task.promise;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageHasText = content.items.some((item) => 'str' in item && item.str.trim().length > 0);
      if (pageHasText) pagesWithText.push(pageNumber);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { hasText: pagesWithText.length > 0, pagesWithText };
}
