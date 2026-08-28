/**
 * Decide whether an item needs OCR, and how to get pixels out of it.
 *
 * The old rule was "images and PDFs". That misses the case a reviewer cares
 * about most: a document that is really a photograph of a page. On real staging
 * data, 2 of 10 .docx attachments extract to no text at all, which means a
 * search can never find them and nothing says so.
 *
 * The rule is deliberately narrow in the other direction too. Tesseract reads
 * pixels, pdftoppm reads PDFs, LibreOffice converts documents — a zip, a
 * calendar invite or an unknown blob is none of those, and queueing OCR for one
 * spends a worker slot to produce nothing.
 */

/**
 * Below this many extracted characters, a document is treated as having no
 * usable text. Not zero: a scan usually yields a stray header, a filename from
 * the container, or a page number, so requiring emptiness would miss most of
 * them.
 */
export const LOW_TEXT_THRESHOLD = 40;

/** Document types LibreOffice can turn into a PDF we can then rasterise. */
const CONVERTIBLE_DOCUMENTS: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/rtf',
  'text/rtf',
]);

export type OcrReason = 'image' | 'pdf' | 'document-without-text' | 'not-ocrable';

export interface OcrDecision {
  run: boolean;
  /** LibreOffice has to make a PDF first; the existing PDF path takes it from there. */
  convertFirst: boolean;
  reason: OcrReason;
}

/** Strip parameters and case, e.g. `image/PNG; charset=binary` -> `image/png`. */
function baseType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

export function ocrDecision(input: { mimeType: string; extractedChars: number }): OcrDecision {
  const mime = baseType(input.mimeType);

  // Incidental text (EXIF, a caption) is not the content of an image.
  if (mime.startsWith('image/')) return { run: true, convertFirst: false, reason: 'image' };

  // A text layer can cover only part of a scanned PDF, so always read the pixels.
  if (mime === 'application/pdf') return { run: true, convertFirst: false, reason: 'pdf' };

  if (CONVERTIBLE_DOCUMENTS.has(mime)) {
    // Only when extraction found nothing worth having. Converting and
    // rasterising a long contract that already extracted cleanly costs minutes
    // per item and produces text we already hold.
    if (input.extractedChars < LOW_TEXT_THRESHOLD) {
      return { run: true, convertFirst: true, reason: 'document-without-text' };
    }
    return { run: false, convertFirst: false, reason: 'not-ocrable' };
  }

  return { run: false, convertFirst: false, reason: 'not-ocrable' };
}
