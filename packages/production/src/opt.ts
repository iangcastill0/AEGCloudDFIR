/**
 * Opticon (.OPT) image cross-reference load file builder.
 *
 * Line format (7 comma-separated fields, CRLF endings):
 *   BatesNumber,VolumeLabel,RelativeImagePath,DocBreak(Y|empty),FolderBreak,BoxBreak,PageCount
 * DocBreak is 'Y' on the first page of each document; PageCount appears only
 * on that first line.
 */

import { ProductionError } from './errors.js';

export interface OptPage {
  batesNumber: string;
  /** Relative image path inside the production, e.g. IMAGES/VOL001/ABC00000001.tif */
  imagePath: string;
  /** Per-page volume label override; falls back to the document/file default. */
  volumeLabel?: string;
}

export interface OptDocument {
  pages: OptPage[];
}

const CRLF = '\r\n';

export function buildOptFile(
  documents: readonly OptDocument[],
  defaultVolumeLabel: string,
): string {
  const lines: string[] = [];
  for (const document of documents) {
    if (document.pages.length === 0) {
      throw new ProductionError('OPT document must have at least one page');
    }
    document.pages.forEach((page, index) => {
      const isFirst = index === 0;
      const fields = [
        page.batesNumber,
        page.volumeLabel ?? defaultVolumeLabel,
        page.imagePath,
        isFirst ? 'Y' : '',
        '', // FolderBreak
        '', // BoxBreak
        isFirst ? String(document.pages.length) : '',
      ];
      for (const field of fields) {
        if (field.includes(',') || field.includes('\r') || field.includes('\n')) {
          throw new ProductionError(`OPT field contains a delimiter or newline: "${field}"`);
        }
      }
      lines.push(fields.join(','));
    });
  }
  return lines.length === 0 ? '' : lines.join(CRLF) + CRLF;
}
