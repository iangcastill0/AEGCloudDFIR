import { describe, expect, it } from 'vitest';
import { buildDatFile, DEFAULT_DAT_PROFILE, type DatFieldMapping } from './dat.js';
import { ProductionError } from './errors.js';
import type { ProducedItemRecord } from './types.js';

const THORN = 'þ';
const DC4 = '\x14';
const REG = '®';

function record(overrides: Partial<ProducedItemRecord> = {}): ProducedItemRecord {
  return {
    begBates: 'ABC00000001',
    endBates: 'ABC00000003',
    begAttach: null,
    endAttach: null,
    custodian: 'Jane Smith',
    sourcePath: '/mail/inbox',
    fileName: 'contract.pdf',
    extension: 'pdf',
    mime: 'application/pdf',
    sha256: 'deadbeef',
    from: 'a@example.com',
    to: 'b@example.com',
    cc: null,
    bcc: null,
    subject: 'Re: contract',
    sentDate: '2024-01-02T03:04:05Z',
    receivedDate: null,
    dateCreated: null,
    dateModified: null,
    textPath: 'TEXT/ABC00000001.txt',
    nativePath: null,
    tags: [],
    ...overrides,
  };
}

describe('buildDatFile', () => {
  it('emits the default profile header with thorn quotes and DC4 delimiters', () => {
    const buf = buildDatFile([], DEFAULT_DAT_PROFILE, {});
    const text = buf.toString('utf8');
    const lines = text.split('\r\n');
    const expectedHeader = [
      'BegBates',
      'EndBates',
      'BegAttach',
      'EndAttach',
      'Custodian',
      'SourcePath',
      'FileName',
      'Extension',
      'MIME',
      'SHA256',
      'From',
      'To',
      'CC',
      'BCC',
      'Subject',
      'SentDate',
      'ReceivedDate',
      'DateCreated',
      'DateModified',
      'TextPath',
      'NativePath',
      'Tags',
    ]
      .map((h) => `${THORN}${h}${THORN}`)
      .join(DC4);
    expect(lines[0]).toBe(expectedHeader);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('writes one row per record with values in profile order', () => {
    const buf = buildDatFile([record()]);
    const rows = buf.toString('utf8').split('\r\n');
    const cells = (rows[1] ?? '').split(DC4).map((c) => c.slice(1, -1));
    expect(cells[0]).toBe('ABC00000001');
    expect(cells[1]).toBe('ABC00000003');
    expect(cells[4]).toBe('Jane Smith');
    expect(cells[2]).toBe(''); // null begAttach -> empty
  });

  it('strips the quote character from values', () => {
    const buf = buildDatFile([record({ subject: `bad${THORN}subject` })]);
    const text = buf.toString('utf8');
    expect(text).toContain(`${THORN}badsubject${THORN}`);
  });

  it('substitutes embedded newlines (CRLF, CR, LF) with the configured character', () => {
    const buf = buildDatFile([record({ subject: 'line1\r\nline2\rline3\nline4' })]);
    expect(buf.toString('utf8')).toContain(
      `${THORN}line1${REG}line2${REG}line3${REG}line4${THORN}`,
    );
  });

  it('joins multi-value tags with the multi-value separator', () => {
    const buf = buildDatFile([record({ tags: ['Hot', 'Privileged Review', 'Q3'] })]);
    expect(buf.toString('utf8')).toContain(`${THORN}Hot; Privileged Review; Q3${THORN}`);
  });

  it('respects a custom profile order and custom delimiters', () => {
    const profile: DatFieldMapping[] = [
      { loadFileField: 'PRODEND', source: 'endBates' },
      { loadFileField: 'PRODBEG', source: 'begBates' },
    ];
    const buf = buildDatFile([record()], profile, {
      fieldDelimiter: '|',
      quoteChar: '~',
      newlineSubstitute: ' ',
    });
    const rows = buf.toString('utf8').split('\r\n');
    expect(rows[0]).toBe('~PRODEND~|~PRODBEG~');
    expect(rows[1]).toBe('~ABC00000003~|~ABC00000001~');
  });

  it('latin1 encoding does not throw on thorn and encodes it as a single 0xFE byte', () => {
    const buf = buildDatFile([record()], DEFAULT_DAT_PROFILE, { encoding: 'latin1' });
    expect(buf[0]).toBe(0xfe);
    // In latin1 each character is exactly one byte, so DC4 stays 0x14.
    expect(buf.includes(0x14)).toBe(true);
  });

  it('utf8 with bom prepends EF BB BF', () => {
    const buf = buildDatFile([], DEFAULT_DAT_PROFILE, { encoding: 'utf8', bom: true });
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('rejects invalid option combinations and empty profiles', () => {
    expect(() => buildDatFile([], [], {})).toThrow(ProductionError);
    expect(() => buildDatFile([], DEFAULT_DAT_PROFILE, { fieldDelimiter: '||' })).toThrow(
      ProductionError,
    );
    expect(() =>
      buildDatFile([], DEFAULT_DAT_PROFILE, { fieldDelimiter: '~', quoteChar: '~' }),
    ).toThrow(ProductionError);
  });
});
