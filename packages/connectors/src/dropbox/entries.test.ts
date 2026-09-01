import { describe, expect, it } from 'vitest';
import { mapDropboxEntry, mapDropboxPage, mimeForFilename } from './entries.js';

const FILE = {
  '.tag': 'file' as const,
  id: 'id:9xY',
  name: 'Q3 report.docx',
  path_display: '/Reports/Q3 report.docx',
  path_lower: '/reports/q3 report.docx',
  size: 24_601,
  rev: '5e2f',
  client_modified: '2026-01-02T03:04:05Z',
  server_modified: '2026-03-04T05:06:07Z',
  content_hash: 'a'.repeat(64),
  is_downloadable: true,
};

describe('mapDropboxEntry', () => {
  it('maps a file onto the shape the pipeline already speaks', () => {
    const entry = mapDropboxEntry(FILE);
    expect(entry).not.toBeNull();
    expect(entry?.providerItemId).toBe('id:9xY');
    expect(entry?.name).toBe('Q3 report.docx');
    expect(entry?.path).toBe('/Reports/Q3 report.docx');
    expect(entry?.size).toBe(24_601);
    expect(entry?.isFolder).toBe(false);
    expect(entry?.downloadable).toBe(true);
  });

  it('uses the id, not the path, as the item id', () => {
    // Dropbox paths change when a custodian renames or moves a file. The id is
    // stable, and re-collecting under a new path would duplicate the evidence.
    const moved = { ...FILE, path_display: '/Archive/2026/Q3 report.docx' };
    expect(mapDropboxEntry(moved)?.providerItemId).toBe(mapDropboxEntry(FILE)?.providerItemId);
  });

  it('takes the modified time from the SERVER, never the client', () => {
    // client_modified is supplied by the uploading device and can be anything.
    // On an evidence timeline that difference matters, so only the server's
    // timestamp is used.
    const entry = mapDropboxEntry(FILE);
    expect(entry?.modifiedAt).toBe('2026-03-04T05:06:07Z');
    expect(entry?.modifiedAt).not.toBe('2026-01-02T03:04:05Z');
  });

  it('does not invent a creation time Dropbox never gives', () => {
    // Dropbox has no creation timestamp. Reusing client_modified for it would
    // put a client-supplied value in a field a reviewer reads as authoritative.
    expect(mapDropboxEntry(FILE)?.createdAt).toBeUndefined();
  });

  it('records the content hash under its real name', () => {
    // Dropbox's content_hash is NOT a sha256 of the file: it is sha256 over the
    // concatenated sha256 of each 4 MiB block. Labelling it sha256 would invite
    // someone to compare it with ours and conclude the evidence was altered.
    const checksums = mapDropboxEntry(FILE)?.checksums ?? {};
    expect(checksums.dropboxContentHash).toBe('a'.repeat(64));
    expect(checksums.sha256).toBeUndefined();
  });

  it('maps a folder, and marks it not downloadable', () => {
    const entry = mapDropboxEntry({
      '.tag': 'folder',
      id: 'id:fold',
      name: 'Reports',
      path_display: '/Reports',
    });
    expect(entry?.isFolder).toBe(true);
    expect(entry?.downloadable).toBe(false);
  });

  it('marks a deleted entry as trashed rather than dropping it', () => {
    // A file that was deleted is itself a finding. Silently discarding it hides
    // that something existed.
    const entry = mapDropboxEntry({ '.tag': 'deleted', name: 'old.txt', path_display: '/old.txt' });
    expect(entry?.trashed).toBe(true);
    expect(entry?.downloadable).toBe(false);
  });

  it('respects is_downloadable when Dropbox says no', () => {
    expect(mapDropboxEntry({ ...FILE, is_downloadable: false })?.downloadable).toBe(false);
  });

  it('returns null for a tag it does not understand', () => {
    // Better to skip and let the caller record an exception than to guess.
    expect(mapDropboxEntry({ '.tag': 'something_new', name: 'x', path_display: '/x' })).toBeNull();
  });
});

describe('mimeForFilename', () => {
  it('infers a type, because Dropbox never sends one', () => {
    expect(mimeForFilename('a.pdf')).toBe('application/pdf');
    expect(mimeForFilename('a.PDF')).toBe('application/pdf');
    expect(mimeForFilename('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(mimeForFilename('photo.jpeg')).toBe('image/jpeg');
  });

  it('falls back to a neutral type rather than guessing', () => {
    // A wrong type sends an item down the wrong processing path. Unknown is
    // honest, and extraction sniffs the bytes anyway.
    expect(mimeForFilename('mystery')).toBe('application/octet-stream');
    expect(mimeForFilename('archive.zzz')).toBe('application/octet-stream');
    expect(mimeForFilename('.hidden')).toBe('application/octet-stream');
  });
});

describe('mapDropboxPage', () => {
  it('carries the cursor only while there is more to read', () => {
    const more = mapDropboxPage({ entries: [FILE], cursor: 'CUR', has_more: true });
    expect(more.nextCursor).toBe('CUR');
    const done = mapDropboxPage({ entries: [FILE], cursor: 'CUR', has_more: false });
    expect(done.nextCursor).toBeUndefined();
  });

  it('keeps the cursor as a delta checkpoint even when the walk is done', () => {
    // Dropbox's cursor doubles as the resume point for later changes, which is
    // what makes an incremental re-collection possible.
    expect(mapDropboxPage({ entries: [], cursor: 'CUR', has_more: false }).deltaCursor).toBe('CUR');
  });

  it('skips entries it cannot map without failing the page', () => {
    const page = mapDropboxPage({
      entries: [FILE, { '.tag': 'something_new', name: 'x', path_display: '/x' }],
      cursor: 'C',
      has_more: false,
    });
    expect(page.items).toHaveLength(1);
  });
});
