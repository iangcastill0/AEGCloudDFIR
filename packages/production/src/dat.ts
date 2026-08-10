/**
 * Concordance (.DAT) delimited load file builder.
 *
 * Defaults follow the Concordance conventions: field delimiter 0x14 (renders
 * as ¶ in Concordance), quote character 0xFE (þ), newline substitute 0xAE (®).
 */

import { ProductionError } from './errors.js';
import type { ProducedItemRecord } from './types.js';

export interface DatFieldMapping {
  /** Column header emitted in the load file. */
  loadFileField: string;
  /** Which ProducedItemRecord field feeds this column. */
  source: keyof ProducedItemRecord;
}

export type DatEncoding = 'utf8' | 'latin1';

export interface DatOptions {
  /** Field delimiter character. Default \x14 (DC4). */
  fieldDelimiter?: string;
  /** Quote character wrapping every value. Default þ (þ). */
  quoteChar?: string;
  /** Replacement for embedded newlines inside values. Default ® (®). */
  newlineSubstitute?: string;
  /** Separator when joining multi-value fields (tags). Default '; '. */
  multiValueSeparator?: string;
  /** Output encoding. Default 'utf8'. */
  encoding?: DatEncoding;
  /** Prepend a UTF-8 BOM (utf8 encoding only). Default false. */
  bom?: boolean;
}

export const DEFAULT_DAT_PROFILE: readonly DatFieldMapping[] = [
  { loadFileField: 'BegBates', source: 'begBates' },
  { loadFileField: 'EndBates', source: 'endBates' },
  { loadFileField: 'BegAttach', source: 'begAttach' },
  { loadFileField: 'EndAttach', source: 'endAttach' },
  { loadFileField: 'Custodian', source: 'custodian' },
  { loadFileField: 'SourcePath', source: 'sourcePath' },
  { loadFileField: 'FileName', source: 'fileName' },
  { loadFileField: 'Extension', source: 'extension' },
  { loadFileField: 'MIME', source: 'mime' },
  { loadFileField: 'SHA256', source: 'sha256' },
  { loadFileField: 'From', source: 'from' },
  { loadFileField: 'To', source: 'to' },
  { loadFileField: 'CC', source: 'cc' },
  { loadFileField: 'BCC', source: 'bcc' },
  { loadFileField: 'Subject', source: 'subject' },
  { loadFileField: 'SentDate', source: 'sentDate' },
  { loadFileField: 'ReceivedDate', source: 'receivedDate' },
  { loadFileField: 'DateCreated', source: 'dateCreated' },
  { loadFileField: 'DateModified', source: 'dateModified' },
  { loadFileField: 'TextPath', source: 'textPath' },
  { loadFileField: 'NativePath', source: 'nativePath' },
  { loadFileField: 'Tags', source: 'tags' },
];

const CRLF = '\r\n';

interface ResolvedDatOptions {
  fieldDelimiter: string;
  quoteChar: string;
  newlineSubstitute: string;
  multiValueSeparator: string;
  encoding: DatEncoding;
  bom: boolean;
}

function resolveOptions(options: DatOptions): ResolvedDatOptions {
  const resolved: ResolvedDatOptions = {
    fieldDelimiter: options.fieldDelimiter ?? '\x14',
    quoteChar: options.quoteChar ?? '\u00FE',
    newlineSubstitute: options.newlineSubstitute ?? '\u00AE',
    multiValueSeparator: options.multiValueSeparator ?? '; ',
    encoding: options.encoding ?? 'utf8',
    bom: options.bom ?? false,
  };
  if (resolved.fieldDelimiter.length !== 1 || resolved.quoteChar.length !== 1) {
    throw new ProductionError('DAT fieldDelimiter and quoteChar must be single characters');
  }
  if (resolved.fieldDelimiter === resolved.quoteChar) {
    throw new ProductionError('DAT fieldDelimiter and quoteChar must differ');
  }
  return resolved;
}

function sanitizeValue(raw: string, opts: ResolvedDatOptions): string {
  return raw
    .split(opts.quoteChar)
    .join('')
    .replace(/\r\n|\r|\n/g, opts.newlineSubstitute)
    .split(opts.fieldDelimiter)
    .join(' ');
}

function recordValue(
  record: ProducedItemRecord,
  source: keyof ProducedItemRecord,
  opts: ResolvedDatOptions,
): string {
  const value = record[source];
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(opts.multiValueSeparator);
  return value;
}

/**
 * Build a Concordance DAT load file from produced item records. Column order
 * follows the profile; every value (and header) is wrapped in the quote
 * character with embedded quote characters stripped and newlines substituted.
 */
export function buildDatFile(
  records: readonly ProducedItemRecord[],
  profile: readonly DatFieldMapping[] = DEFAULT_DAT_PROFILE,
  options: DatOptions = {},
): Buffer {
  if (profile.length === 0) {
    throw new ProductionError('DAT profile must contain at least one field');
  }
  const opts = resolveOptions(options);
  const q = opts.quoteChar;
  const wrap = (v: string): string => `${q}${sanitizeValue(v, opts)}${q}`;

  const lines: string[] = [];
  lines.push(profile.map((f) => wrap(f.loadFileField)).join(opts.fieldDelimiter));
  for (const record of records) {
    lines.push(
      profile
        .map((f) => wrap(recordValue(record, f.source, opts)))
        .join(opts.fieldDelimiter),
    );
  }
  const body = lines.join(CRLF) + CRLF;
  const text = opts.bom && opts.encoding === 'utf8' ? `\uFEFF${body}` : body;
  return Buffer.from(text, opts.encoding);
}
