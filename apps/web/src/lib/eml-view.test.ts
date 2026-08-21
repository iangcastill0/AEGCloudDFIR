import { describe, expect, it } from 'vitest';
import {
  emlContextRows,
  emlHeaderRows,
  formatAddressList,
  hadHiddenBcc,
  isEmailLike,
  type EmlSource,
} from './eml-view';

function email(over: Partial<EmlSource> = {}): EmlSource {
  return {
    kind: 'email',
    name: 'Q3 numbers',
    primaryDate: '2026-03-04T05:06:07.000Z',
    emailMetadata: {
      subject: 'Q3 numbers',
      sentAt: '2026-03-04T05:06:07.000Z',
      folder: 'Inbox',
      bccPresent: false,
    },
    participants: [
      { role: 'from', name: 'Alice Smith', address: 'alice@example.com' },
      { role: 'to', name: '', address: 'bob@example.com' },
      { role: 'to', name: 'Carol', address: 'carol@example.com' },
      { role: 'cc', name: '', address: 'dave@example.com' },
    ],
    headers: [],
    ...over,
  };
}

describe('formatAddressList', () => {
  it('writes a name with its address in angle brackets', () => {
    expect(formatAddressList(email().participants, 'from')).toBe('Alice Smith <alice@example.com>');
  });

  it('writes the address alone when there is no name', () => {
    expect(formatAddressList(email().participants, 'cc')).toBe('dave@example.com');
  });

  it('joins several people with commas, in order', () => {
    expect(formatAddressList(email().participants, 'to')).toBe(
      'bob@example.com, Carol <carol@example.com>',
    );
  });

  it('returns an empty string when nobody has that role', () => {
    expect(formatAddressList(email().participants, 'reply_to')).toBe('');
  });
});

describe('emlHeaderRows', () => {
  it('lays out From, To, Cc, Subject and Date', () => {
    const rows = emlHeaderRows(email());
    expect(rows.map((r) => r.label)).toEqual(['From', 'To', 'Cc', 'Subject', 'Date']);
    expect(rows[0]?.value).toBe('Alice Smith <alice@example.com>');
    expect(rows[3]?.value).toBe('Q3 numbers');
  });

  it('skips a row nobody filled in, rather than showing an empty line', () => {
    const rows = emlHeaderRows(
      email({ participants: [{ role: 'from', name: '', address: 'a@b.com' }] }),
    );
    expect(rows.map((r) => r.label)).toEqual(['From', 'Subject', 'Date']);
  });

  it('falls back to the raw headers when there are no parsed participants', () => {
    // Mail collected through Graph or Gmail can arrive with no raw MIME, and
    // mail from a PST can arrive with headers but no participant rows. Either
    // source alone must still produce a readable view.
    const rows = emlHeaderRows(
      email({
        participants: [],
        headers: [
          { name: 'from', value: 'Eve <eve@example.com>' },
          { name: 'to', value: 'frank@example.com' },
        ],
      }),
    );
    expect(rows.find((r) => r.label === 'From')?.value).toBe('Eve <eve@example.com>');
    expect(rows.find((r) => r.label === 'To')?.value).toBe('frank@example.com');
  });

  it('prefers parsed participants over raw headers when both exist', () => {
    const rows = emlHeaderRows(
      email({ headers: [{ name: 'from', value: 'spoofed@example.com' }] }),
    );
    expect(rows[0]?.value).toBe('Alice Smith <alice@example.com>');
  });

  it('never shows a bcc row, even if one somehow reaches the browser', () => {
    const rows = emlHeaderRows(
      email({
        participants: [
          { role: 'from', name: '', address: 'a@b.com' },
          { role: 'bcc', name: '', address: 'hidden@example.com' },
        ],
        headers: [{ name: 'bcc', value: 'hidden@example.com' }],
      }),
    );
    expect(rows.map((r) => r.label)).not.toContain('Bcc');
    expect(JSON.stringify(rows)).not.toContain('hidden@example.com');
  });

  it('uses the subject from the item name when the metadata has none', () => {
    const rows = emlHeaderRows(email({ emailMetadata: { bccPresent: false } }));
    expect(rows.find((r) => r.label === 'Subject')?.value).toBe('Q3 numbers');
  });

  it('prefers the sent date, then the item date', () => {
    const sent = emlHeaderRows(email());
    expect(sent.find((r) => r.label === 'Date')?.value).toContain('2026');

    const noSent = emlHeaderRows(
      email({ emailMetadata: { bccPresent: false }, primaryDate: '2026-01-02T03:04:05.000Z' }),
    );
    expect(noSent.find((r) => r.label === 'Date')?.value).toContain('2026');
  });
});

describe('isEmailLike', () => {
  it('is true for an email', () => {
    expect(isEmailLike(email())).toBe(true);
  });

  it('is true when metadata says it is a message, whatever the kind says', () => {
    expect(isEmailLike(email({ kind: 'file' }))).toBe(true);
  });

  it('is false for a plain file', () => {
    expect(isEmailLike(email({ kind: 'file', emailMetadata: null, participants: [] }))).toBe(false);
  });
});

describe('emlContextRows — what we observed, not what the message says', () => {
  it('keeps the folder out of the header rows', () => {
    // A mailbox folder is an observation about where the copy was found. Listing
    // it beside From and To would make the view claim more than the message does.
    expect(emlHeaderRows(email()).map((r) => r.label)).not.toContain('Folder');
    expect(emlContextRows(email()).map((r) => r.label)).toContain('Folder');
  });

  it('is empty for a message with no folder or message id', () => {
    expect(emlContextRows(email({ emailMetadata: { bccPresent: false } }))).toEqual([]);
  });
});

describe('hadHiddenBcc', () => {
  it('is true only when the metadata says a bcc existed', () => {
    expect(hadHiddenBcc(email({ emailMetadata: { bccPresent: true } }))).toBe(true);
    expect(hadHiddenBcc(email())).toBe(false);
    expect(hadHiddenBcc(email({ emailMetadata: null }))).toBe(false);
  });
});
