import { describe, expect, it } from 'vitest';
import { buildCsvFile, csvEscape } from './csv.js';
import { ProductionError } from './errors.js';
import type { ProducedItemRecord } from './types.js';
import type { DatFieldMapping } from './dat.js';

describe('csvEscape', () => {
  it('passes plain values through unquoted', () => {
    expect(csvEscape('hello world')).toBe('hello world');
  });

  it('applies RFC 4180 quoting for delimiter, quote, and newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('supports a configurable delimiter', () => {
    expect(csvEscape('a,b', { delimiter: ';' })).toBe('a,b');
    expect(csvEscape('a;b', { delimiter: ';' })).toBe('"a;b"');
    expect(() => csvEscape('x', { delimiter: ';;' })).toThrow(ProductionError);
    expect(() => csvEscape('x', { delimiter: '"' })).toThrow(ProductionError);
  });

  it('guards spreadsheet formula injection with a leading apostrophe', () => {
    expect(csvEscape('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvEscape('+x')).toBe("'+x");
    expect(csvEscape('-x')).toBe("'-x");
    expect(csvEscape('@x')).toBe("'@x");
    expect(csvEscape('\tx')).toBe('"\'\tx"'); // tab also forces quoting
    expect(csvEscape('\rx')).toBe('"\'\rx"');
    expect(csvEscape('safe=value')).toBe('safe=value'); // only leading chars trigger
  });

  it('formula guard composes with quoting', () => {
    expect(csvEscape('=1,2')).toBe('"\'=1,2"');
  });
});

function record(overrides: Partial<ProducedItemRecord> = {}): ProducedItemRecord {
  return {
    begBates: 'ABC00000001',
    endBates: 'ABC00000002',
    begAttach: null,
    endAttach: null,
    custodian: 'Smith, Jane',
    sourcePath: null,
    fileName: 'notes.txt',
    extension: 'txt',
    mime: 'text/plain',
    sha256: null,
    from: null,
    to: null,
    cc: null,
    bcc: null,
    subject: '=IMPORTANT',
    sentDate: null,
    receivedDate: null,
    dateCreated: null,
    dateModified: null,
    textPath: null,
    nativePath: null,
    tags: ['A', 'B'],
    ...overrides,
  };
}

describe('buildCsvFile', () => {
  const profile: DatFieldMapping[] = [
    { loadFileField: 'BegBates', source: 'begBates' },
    { loadFileField: 'Custodian', source: 'custodian' },
    { loadFileField: 'Subject', source: 'subject' },
    { loadFileField: 'Tags', source: 'tags' },
  ];

  it('emits CRLF rows with header, quoting, and injection guarding', () => {
    const csv = buildCsvFile([record()], profile);
    expect(csv).toBe(
      'BegBates,Custodian,Subject,Tags\r\n' + 'ABC00000001,"Smith, Jane",\'=IMPORTANT,A; B\r\n',
    );
  });

  it('honors a custom delimiter end to end', () => {
    const csv = buildCsvFile([record()], profile, { delimiter: '|' });
    expect(csv).toBe(
      'BegBates|Custodian|Subject|Tags\r\n' + "ABC00000001|Smith, Jane|'=IMPORTANT|A; B\r\n",
    );
  });

  it('rejects an empty profile', () => {
    expect(() => buildCsvFile([], [])).toThrow(ProductionError);
  });
});
