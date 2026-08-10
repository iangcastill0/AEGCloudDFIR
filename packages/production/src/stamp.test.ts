import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { ProductionError } from './errors.js';
import { resolveStampPlacements, stampPdf } from './stamp.js';
import type { StampConfig } from './types.js';

interface ExtractedItem {
  str: string;
  x: number;
  y: number;
}

async function extractItems(pdfBytes: Uint8Array): Promise<ExtractedItem[][]> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: ExtractedItem[][] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: ExtractedItem[] = [];
      for (const item of content.items) {
        if ('str' in item && item.str.trim().length > 0) {
          items.push({ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0 });
        }
      }
      pages.push(items);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

async function makeTwoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['Page one body', 'Page two body']) {
    const page = doc.addPage([612, 792]);
    page.drawText(label, { x: 72, y: 400, size: 12, font });
  }
  return doc.save();
}

function stamp(overrides: Partial<StampConfig>): StampConfig {
  return {
    position: 'bottom_right',
    kind: 'custom',
    text: 'STAMP',
    priority: 5,
    addedMarginPoints: 0,
    ...overrides,
  };
}

describe('stampPdf', () => {
  it('stamps the per-page bates number on every page at distinct positions', async () => {
    const pdf = await makeTwoPagePdf();
    const result = await stampPdf(pdf, {
      stamps: [
        stamp({ position: 'bottom_right', kind: 'bates' }),
        stamp({ position: 'top_left', kind: 'confidentiality', text: 'CONFIDENTIAL' }),
      ],
      pageBatesNumbers: ['ABC00000001', 'ABC00000002'],
    });
    expect(result.droppedStamps).toEqual([]);
    const pages = await extractItems(result.pdfBytes);
    expect(pages).toHaveLength(2);

    const batesPage1 = pages[0]?.find((i) => i.str === 'ABC00000001');
    const batesPage2 = pages[1]?.find((i) => i.str === 'ABC00000002');
    expect(batesPage1).toBeDefined();
    expect(batesPage2).toBeDefined();
    // Original content survives.
    expect(pages[0]?.some((i) => i.str === 'Page one body')).toBe(true);
    expect(pages[1]?.some((i) => i.str === 'Page two body')).toBe(true);

    const confidential = pages[0]?.find((i) => i.str === 'CONFIDENTIAL');
    expect(confidential).toBeDefined();
    // Positions differ: bates bottom-right vs confidentiality top-left.
    expect((batesPage1?.x ?? 0) > (confidential?.x ?? 0)).toBe(true);
    expect((batesPage1?.y ?? 0) < (confidential?.y ?? 0)).toBe(true);
  });

  it('drops the lower-priority stamp on a position collision and records it', async () => {
    const pdf = await makeTwoPagePdf();
    const result = await stampPdf(pdf, {
      stamps: [
        stamp({ position: 'bottom_center', kind: 'tag', text: 'LOSER', priority: 2 }),
        stamp({ position: 'bottom_center', kind: 'confidentiality', text: 'WINNER', priority: 8 }),
      ],
    });
    expect(result.droppedStamps).toEqual([
      {
        position: 'bottom_center',
        kind: 'tag',
        priority: 2,
        text: 'LOSER',
        reason: 'position_collision',
      },
    ]);
    const pages = await extractItems(result.pdfBytes);
    expect(pages[0]?.some((i) => i.str === 'WINNER')).toBe(true);
    expect(pages[0]?.some((i) => i.str === 'LOSER')).toBe(false);
  });

  it('earlier stamp wins a priority tie', () => {
    const first = stamp({ position: 'top_center', text: 'FIRST', priority: 5 });
    const second = stamp({ position: 'top_center', text: 'SECOND', priority: 5 });
    const { kept, dropped } = resolveStampPlacements([first, second]);
    expect(kept.get('top_center')?.text).toBe('FIRST');
    expect(dropped[0]?.text).toBe('SECOND');
  });

  it('margin mode enlarges the media box instead of covering content', async () => {
    const pdf = await makeTwoPagePdf();
    const margin = 36;
    const result = await stampPdf(pdf, {
      stamps: [
        stamp({ position: 'bottom_center', kind: 'bates', addedMarginPoints: margin }),
        stamp({ position: 'top_center', kind: 'custom', text: 'TOP BAND', addedMarginPoints: margin }),
      ],
      pageBatesNumbers: ['ABC00000001', 'ABC00000002'],
    });
    const stamped = await PDFDocument.load(result.pdfBytes);
    const size = stamped.getPage(0).getSize();
    expect(size.width).toBe(612);
    expect(size.height).toBe(792 + margin * 2);

    const pages = await extractItems(result.pdfBytes);
    const bates = pages[0]?.find((i) => i.str === 'ABC00000001');
    const top = pages[0]?.find((i) => i.str === 'TOP BAND');
    const body = pages[0]?.find((i) => i.str === 'Page one body');
    expect(bates).toBeDefined();
    expect(top).toBeDefined();
    // Stamps sit inside the added bands, outside the original content box.
    expect((bates?.y ?? Infinity) < margin).toBe(true);
    expect((top?.y ?? 0) > 792 + margin).toBe(true);
    // Original content shifted up by the bottom band.
    expect(Math.round(body?.y ?? 0)).toBe(400 + margin);
  });

  it('throws when a bates stamp has no per-page numbers', async () => {
    const pdf = await makeTwoPagePdf();
    await expect(
      stampPdf(pdf, { stamps: [stamp({ kind: 'bates' })] }),
    ).rejects.toThrow(ProductionError);
    await expect(
      stampPdf(pdf, { stamps: [stamp({ kind: 'bates' })], pageBatesNumbers: ['ONLY-ONE'] }),
    ).rejects.toThrow(ProductionError);
  });
});
