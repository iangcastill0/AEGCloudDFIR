/**
 * Map Dropbox metadata onto the DriveEntry shape the pipeline already speaks.
 *
 * Four things here are easy to get wrong, and each one would quietly corrupt
 * what a reviewer believes:
 *
 *  - **Identity is the id, not the path.** Dropbox paths change on any rename
 *    or move. Keying on the path would re-collect a moved file as a new one.
 *  - **Times come from the server.** `client_modified` is supplied by whatever
 *    device uploaded the file and can hold any value at all. `server_modified`
 *    is the one Dropbox observed.
 *  - **There is no creation time.** Dropbox does not record one. Borrowing
 *    `client_modified` to fill the field would put a client-controlled value
 *    somewhere a reviewer reads as authoritative.
 *  - **`content_hash` is not a SHA-256 of the file.** It is SHA-256 over the
 *    concatenated SHA-256 of each 4 MiB block. Storing it as `sha256` would
 *    invite a comparison against our own digest and a false conclusion that the
 *    evidence was altered.
 *
 * Pure: no network needed to test any of it.
 */
import type { DriveEntry, DriveListPage } from '../types.js';

/** Only what we read. Dropbox sends more, and may add more. */
export interface RawDropboxEntry {
  '.tag': string;
  id?: string;
  name: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  rev?: string;
  client_modified?: string;
  server_modified?: string;
  content_hash?: string;
  is_downloadable?: boolean;
  sharing_info?: unknown;
}

export interface RawDropboxPage {
  entries: RawDropboxEntry[];
  cursor: string;
  has_more: boolean;
}

/**
 * Extension to media type. Dropbox never sends one, and the pipeline routes on
 * it — email parses, documents extract, images OCR.
 *
 * Short on purpose: extraction sniffs the actual bytes later, so a missing
 * entry costs nothing, while a wrong guess sends an item down the wrong path.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  pst: 'application/vnd.ms-outlook-pst',
  zip: 'application/zip',
  gz: 'application/gzip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** Neutral rather than wrong: unknown bytes get sniffed downstream. */
const UNKNOWN_MIME = 'application/octet-stream';

export function mimeForFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension: '.hidden' has no type.
  if (dot <= 0 || dot === name.length - 1) return UNKNOWN_MIME;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? UNKNOWN_MIME;
}

/** One entry, or null when Dropbox sent a tag this version does not understand. */
export function mapDropboxEntry(raw: RawDropboxEntry): DriveEntry | null {
  const tag = raw['.tag'];
  const path = raw.path_display ?? raw.path_lower ?? `/${raw.name}`;

  if (tag === 'deleted') {
    // A file that once existed is itself a finding. Dropping it silently would
    // hide that, so it is reported as trashed and not downloadable.
    return {
      providerItemId: raw.id ?? path,
      name: raw.name,
      mimeType: mimeForFilename(raw.name),
      path,
      checksums: {},
      isFolder: false,
      downloadable: false,
      trashed: true,
    };
  }

  if (tag === 'folder') {
    return {
      providerItemId: raw.id ?? path,
      name: raw.name,
      mimeType: 'application/vnd.dropbox.folder',
      path,
      checksums: {},
      isFolder: true,
      downloadable: false,
    };
  }

  if (tag !== 'file') return null;

  return {
    providerItemId: raw.id ?? path,
    name: raw.name,
    mimeType: mimeForFilename(raw.name),
    path,
    checksums: raw.content_hash === undefined ? {} : { dropboxContentHash: raw.content_hash },
    isFolder: false,
    // Dropbox marks some items (certain shared or restricted files) as not
    // downloadable. Trying anyway spends a request to earn a 409.
    downloadable: raw.is_downloadable ?? true,
    ...(raw.size === undefined ? {} : { size: raw.size }),
    ...(raw.server_modified === undefined ? {} : { modifiedAt: raw.server_modified }),
    ...(raw.sharing_info === undefined ? {} : { sharedSummary: raw.sharing_info }),
  };
}

/**
 * One page of a listing.
 *
 * `cursor` is kept as `deltaCursor` even when the walk is finished, because in
 * Dropbox the same token is the resume point for later changes — that is what
 * makes an incremental re-collection possible.
 */
export function mapDropboxPage(raw: RawDropboxPage): DriveListPage {
  const items: DriveEntry[] = [];
  for (const item of raw.entries) {
    const mapped = mapDropboxEntry(item);
    // One unrecognised entry must not lose the whole page.
    if (mapped !== null) items.push(mapped);
  }
  return {
    items,
    ...(raw.has_more ? { nextCursor: raw.cursor } : {}),
    ...(raw.cursor === '' ? {} : { deltaCursor: raw.cursor }),
  };
}
