import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

export interface PlaceholderInput {
  /** Human-readable reason the document could not be produced as an image. */
  reason: string;
  evidenceId: string;
  batesNumber: string;
  /** Extra key/value lines rendered under the reason. */
  metadata?: Record<string, string>;
}

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const BODY_SIZE = 12;
const TITLE_SIZE = 18;
const LINE_HEIGHT = 18;

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current.length === 0) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Render a single-page placeholder PDF for documents that could not be
 * converted to the requested image format (unsupported type, corrupt file,
 * encryption, etc.). The placeholder occupies the document's bates position.
 */
export async function renderPlaceholderPdf(input: PlaceholderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  let y = PAGE_HEIGHT - MARGIN;
  const drawLine = (text: string, font: PDFFont, size: number): void => {
    page.drawText(text, { x: MARGIN, y: y - size, size, font, color: black });
    y -= size === TITLE_SIZE ? size + LINE_HEIGHT : LINE_HEIGHT;
  };

  drawLine('DOCUMENT PLACEHOLDER', bold, TITLE_SIZE);
  for (const line of wrapText(input.reason, regular, BODY_SIZE, maxWidth)) {
    drawLine(line, regular, BODY_SIZE);
  }
  y -= LINE_HEIGHT;
  drawLine(`Evidence ID: ${input.evidenceId}`, regular, BODY_SIZE);
  drawLine(`Bates Number: ${input.batesNumber}`, regular, BODY_SIZE);
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    for (const line of wrapText(`${key}: ${value}`, regular, BODY_SIZE, maxWidth)) {
      drawLine(line, regular, BODY_SIZE);
    }
  }

  return doc.save();
}
