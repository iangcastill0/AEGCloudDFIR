/**
 * What preview, if any, a file gets — and when there is none, why.
 *
 * Pure on purpose. This is the table that decides whether a reviewer can see a
 * document, so it is the part that must be readable and testable without
 * spawning LibreOffice.
 *
 * Before this existed, previews were generated in exactly one place — the
 * email parser — and the `process.preview` queue was a no-op consumer. Every
 * attachment in a real 43,379-item matter therefore showed "No safe preview is
 * available": 1,379 of them, including 759 PNGs and 184 PDFs. The bytes were
 * collected and exportable the whole time; they simply could not be looked at.
 *
 * Everything here is done with tools already in the worker image — LibreOffice,
 * poppler (pdftoppm), ghostscript, tesseract. Nothing new is installed.
 */

export type PreviewAction =
  /** Serve the collected bytes as-is. Exact fidelity, no re-encode. */
  | 'image'
  /** Rasterise pages to PNG with pdftoppm. */
  | 'rasterize'
  /** LibreOffice to PDF first, then rasterise. */
  | 'convert-then-rasterize'
  /** Render the bytes as plain text. */
  | 'text'
  /** No visual preview. `reason` says why, and the native file is always there. */
  | 'none';

export interface PreviewPlan {
  action: PreviewAction;
  /** Shown to the reviewer when action is 'none'. Never blank. */
  reason: string;
  /** Extension LibreOffice needs to pick an import filter. */
  extension?: string;
}

const plan = (action: PreviewAction, reason = '', extension?: string): PreviewPlan => ({
  action,
  reason,
  ...(extension === undefined ? {} : { extension }),
});

/**
 * Raster image formats a browser renders natively.
 *
 * These are served as the collected bytes rather than re-encoded. For evidence
 * that is the right call twice over: a reviewer should see the pixels that were
 * collected, not a recompression of them, and the worker image has no image
 * library to recompress with anyway.
 *
 * SVG is deliberately NOT here. It is XML that can carry script, and a
 * presigned URL opened directly in a tab would execute it. It goes through
 * LibreOffice instead, which renders it and drops the script.
 */
const DIRECT_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-ms-bmp',
  'image/tiff',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
  'image/heic',
  'image/heif',
]);

/** Text-ish types worth showing as text. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
  'text/calendar',
  'text/rfc822-headers',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-sharing-metadata-xml',
  'text/vcard',
  'text/x-vcard',
]);

/**
 * Anything LibreOffice opens. The extension matters: soffice picks its import
 * filter from the file name, not from sniffing.
 */
const CONVERTIBLE_TYPES: ReadonlyMap<string, string> = new Map([
  // OOXML
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  // Legacy Office
  ['application/msword', 'doc'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  // OpenDocument
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
  ['application/vnd.oasis.opendocument.graphics', 'odg'],
  // Other word processors LibreOffice reads and Tika often will not
  ['application/rtf', 'rtf'],
  ['text/rtf', 'rtf'],
  ['application/x-mspublisher', 'pub'],
  ['application/vnd.ms-publisher', 'pub'],
  ['application/vnd.visio', 'vsd'],
  ['application/x-visio', 'vsd'],
  ['application/wordperfect', 'wpd'],
  ['application/x-wordperfect', 'wpd'],
  ['application/vnd.wordperfect', 'wpd'],
  ['application/x-mswrite', 'wri'],
  ['application/vnd.ms-works', 'wps'],
  ['application/x-abiword', 'abw'],
  // Vector images: rendered rather than served, so embedded script cannot run.
  ['image/svg+xml', 'svg'],
  // HTML is rendered rather than served for the same reason.
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
]);

/** Types we can name in the "no preview" note, so it is never just "unknown". */
const KNOWN_UNPREVIEWABLE: ReadonlyMap<string, string> = new Map([
  ['application/zip', 'a ZIP archive'],
  ['application/x-zip-compressed', 'a ZIP archive'],
  ['application/x-7z-compressed', 'a 7-Zip archive'],
  ['application/x-rar-compressed', 'a RAR archive'],
  ['application/vnd.rar', 'a RAR archive'],
  ['application/gzip', 'a gzip archive'],
  ['application/x-tar', 'a TAR archive'],
  ['application/vnd.ms-outlook-pst', 'an Outlook PST container'],
  ['application/vnd.ms-outlook', 'an Outlook message'],
  ['message/rfc822', 'an email message'],
  ['application/octet-stream', 'an unrecognised binary file'],
]);

function normalize(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Decide the preview for one file.
 *
 * `name` is only consulted when the mime type is uninformative —
 * `application/octet-stream` is what a provider sends when it did not look,
 * and the extension often still tells the truth.
 */
export function previewPlan(mimeType: string, name = ''): PreviewPlan {
  const mime = normalize(mimeType);

  if (DIRECT_IMAGE_TYPES.has(mime)) return plan('image');
  if (mime === 'application/pdf') return plan('rasterize');

  const convertible = CONVERTIBLE_TYPES.get(mime);
  if (convertible !== undefined) return plan('convert-then-rasterize', '', convertible);

  if (TEXT_TYPES.has(mime) || mime.startsWith('text/')) return plan('text');

  if (mime.startsWith('video/')) {
    return plan('none', 'This is a video. Download the native file to play it.');
  }
  if (mime.startsWith('audio/')) {
    return plan('none', 'This is an audio file. Download the native file to play it.');
  }

  // Uninformative type: fall back to the file name before giving up.
  if (mime === '' || mime === 'application/octet-stream') {
    const ext = extensionOf(name);
    for (const [candidateMime, candidateExt] of CONVERTIBLE_TYPES) {
      if (candidateExt === ext) return plan('convert-then-rasterize', '', candidateExt);
      void candidateMime;
    }
    if (ext === 'pdf') return plan('rasterize');
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) {
      return plan('image');
    }
    if (['txt', 'csv', 'log', 'json', 'xml', 'md'].includes(ext)) return plan('text');
  }

  const described = KNOWN_UNPREVIEWABLE.get(mime);
  if (described !== undefined) {
    return plan('none', `This is ${described}. Download the native file to open it.`);
  }
  return plan(
    'none',
    `No preview can be rendered for ${mime === '' ? 'this file type' : mime}. ` +
      `The native file was collected and can be downloaded.`,
  );
}
