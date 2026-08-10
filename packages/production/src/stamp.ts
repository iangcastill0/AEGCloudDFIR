import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { ProductionError } from './errors.js';
import type { StampConfig, StampPosition } from './types.js';

/** Horizontal inset (points) from the page edge for left/right stamps. */
const EDGE_INSET = 18;
/** Vertical inset (points) used when no margin band is added. */
const VERTICAL_INSET = 14;
const STAMP_FONT_SIZE = 10;

export interface DroppedStamp {
  position: StampPosition;
  kind: StampConfig['kind'];
  priority: number;
  text: string;
  reason: 'position_collision';
}

export interface StampPdfOptions {
  stamps: StampConfig[];
  /**
   * Bates string per page index (0-based). Required when any stamp has
   * kind 'bates'.
   */
  pageBatesNumbers?: string[];
}

export interface StampPdfResult {
  pdfBytes: Uint8Array;
  /** Stamps that lost a position collision to a higher-priority stamp. */
  droppedStamps: DroppedStamp[];
}

interface PlacementResolution {
  kept: Map<StampPosition, StampConfig>;
  dropped: DroppedStamp[];
}

/**
 * Resolve position collisions: for each of the six positions the
 * highest-priority stamp wins; on a priority tie the earlier stamp in the
 * array wins. Losers are recorded as dropped.
 */
export function resolveStampPlacements(stamps: readonly StampConfig[]): PlacementResolution {
  const kept = new Map<StampPosition, StampConfig>();
  const dropped: DroppedStamp[] = [];
  for (const stamp of stamps) {
    const incumbent = kept.get(stamp.position);
    if (incumbent === undefined) {
      kept.set(stamp.position, stamp);
      continue;
    }
    const loser = stamp.priority > incumbent.priority ? incumbent : stamp;
    const winner = loser === incumbent ? stamp : incumbent;
    kept.set(stamp.position, winner);
    dropped.push({
      position: loser.position,
      kind: loser.kind,
      priority: loser.priority,
      text: loser.text,
      reason: 'position_collision',
    });
  }
  return { kept, dropped };
}

function stampX(position: StampPosition, pageWidth: number, textWidth: number): number {
  if (position.endsWith('_left')) return EDGE_INSET;
  if (position.endsWith('_right')) return Math.max(EDGE_INSET, pageWidth - textWidth - EDGE_INSET);
  return Math.max(EDGE_INSET, (pageWidth - textWidth) / 2);
}

function stampText(stamp: StampConfig, batesForPage: string | undefined): string {
  if (stamp.kind === 'bates') {
    if (batesForPage === undefined) {
      throw new ProductionError('a bates stamp requires pageBatesNumbers for every page');
    }
    return batesForPage;
  }
  return stamp.text;
}

interface DrawTarget {
  drawText: (
    text: string,
    opts: { x: number; y: number; size: number; font: PDFFont },
  ) => void;
}

function drawStamps(
  target: DrawTarget,
  kept: ReadonlyMap<StampPosition, StampConfig>,
  font: PDFFont,
  layout: {
    pageWidth: number;
    contentHeight: number;
    bottomBand: number;
    topBand: number;
  },
  batesForPage: string | undefined,
): void {
  const { pageWidth, contentHeight, bottomBand, topBand } = layout;
  for (const stamp of kept.values()) {
    const text = stampText(stamp, batesForPage);
    if (text.length === 0) continue;
    const textWidth = font.widthOfTextAtSize(text, STAMP_FONT_SIZE);
    const x = stampX(stamp.position, pageWidth, textWidth);
    let y: number;
    if (stamp.position.startsWith('top_')) {
      y =
        topBand > 0
          ? bottomBand + contentHeight + (topBand - STAMP_FONT_SIZE) / 2
          : bottomBand + contentHeight - VERTICAL_INSET - STAMP_FONT_SIZE;
    } else {
      y = bottomBand > 0 ? (bottomBand - STAMP_FONT_SIZE) / 2 : VERTICAL_INSET;
    }
    target.drawText(text, { x, y, size: STAMP_FONT_SIZE, font });
  }
}

/**
 * Stamp text onto every page of a PDF.
 *
 * - Six positions (top/bottom x left/center/right); collisions resolved by
 *   priority, dropped stamps reported.
 * - kind 'bates' renders the per-page bates number from
 *   `options.pageBatesNumbers`; other kinds render their fixed text.
 * - When any kept stamp has `addedMarginPoints > 0`, the page is enlarged on
 *   the stamped edge (original content embedded unscaled and shifted) so
 *   stamps never cover content.
 */
export async function stampPdf(
  pdfBytes: Uint8Array,
  options: StampPdfOptions,
): Promise<StampPdfResult> {
  const { kept, dropped } = resolveStampPlacements(options.stamps);

  const topBand = Math.max(
    0,
    ...[...kept.values()]
      .filter((s) => s.position.startsWith('top_'))
      .map((s) => s.addedMarginPoints),
  );
  const bottomBand = Math.max(
    0,
    ...[...kept.values()]
      .filter((s) => s.position.startsWith('bottom_'))
      .map((s) => s.addedMarginPoints),
  );

  const srcDoc = await PDFDocument.load(pdfBytes);
  const pageCount = srcDoc.getPageCount();
  const batesNumbers = options.pageBatesNumbers;
  const needsBates = [...kept.values()].some((s) => s.kind === 'bates');
  if (needsBates && (batesNumbers === undefined || batesNumbers.length < pageCount)) {
    throw new ProductionError(
      `pageBatesNumbers must provide one bates string per page (${pageCount} pages)`,
    );
  }

  if (topBand === 0 && bottomBand === 0) {
    const font = await srcDoc.embedFont(StandardFonts.Helvetica);
    const black = rgb(0, 0, 0);
    srcDoc.getPages().forEach((page, index) => {
      const { width, height } = page.getSize();
      drawStamps(
        {
          drawText: (text, opts) => page.drawText(text, { ...opts, color: black }),
        },
        kept,
        font,
        { pageWidth: width, contentHeight: height, bottomBand: 0, topBand: 0 },
        batesNumbers?.[index],
      );
    });
    return { pdfBytes: await srcDoc.save(), droppedStamps: dropped };
  }

  // Margin mode: rebuild each page with an enlarged media box, embedding the
  // original page content unscaled and shifted above the bottom band.
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const black = rgb(0, 0, 0);
  for (let index = 0; index < pageCount; index += 1) {
    const srcPage = srcDoc.getPage(index);
    const { width, height } = srcPage.getSize();
    const embedded = await outDoc.embedPage(srcPage);
    const page = outDoc.addPage([width, height + topBand + bottomBand]);
    page.drawPage(embedded, { x: 0, y: bottomBand, width, height });
    drawStamps(
      {
        drawText: (text, opts) => page.drawText(text, { ...opts, color: black }),
      },
      kept,
      font,
      { pageWidth: width, contentHeight: height, bottomBand, topBand },
      batesNumbers?.[index],
    );
  }
  return { pdfBytes: await outDoc.save(), droppedStamps: dropped };
}
