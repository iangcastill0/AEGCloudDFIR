/**
 * RFC 4180 CSV load file builder with spreadsheet formula-injection guarding.
 */

import { ProductionError } from './errors.js';
import type { ProducedItemRecord } from './types.js';
import type { DatFieldMapping } from './dat.js';
import { DEFAULT_DAT_PROFILE } from './dat.js';

export interface CsvOptions {
  /** Field delimiter. Default ','. */
  delimiter?: string;
  /** Separator when joining multi-value fields (tags). Default '; '. */
  multiValueSeparator?: string;
}

/** Characters that make a spreadsheet interpret a cell as a formula. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Escape one CSV value: neutralize formula injection (leading = + - @ tab CR
 * gets a leading apostrophe) then apply RFC 4180 quoting.
 */
export function csvEscape(value: string, options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1 || delimiter === '"') {
    throw new ProductionError(
      `CSV delimiter must be a single non-quote character, got "${delimiter}"`,
    );
  }
  let v = value;
  const first = v.charAt(0);
  if (first !== '' && FORMULA_TRIGGERS.has(first)) {
    v = `'${v}`;
  }
  if (
    v.includes('"') ||
    v.includes(delimiter) ||
    v.includes('\r') ||
    v.includes('\n') ||
    v.includes('\t')
  ) {
    return `"${v.replaceAll('"', '""')}"`;
  }
  return v;
}

const CRLF = '\r\n';

/**
 * Build a CSV load file using the same field-mapping profiles as DAT.
 * Rows are CRLF-terminated per RFC 4180.
 */
export function buildCsvFile(
  records: readonly ProducedItemRecord[],
  profile: readonly DatFieldMapping[] = DEFAULT_DAT_PROFILE,
  options: CsvOptions = {},
): string {
  if (profile.length === 0) {
    throw new ProductionError('CSV profile must contain at least one field');
  }
  const delimiter = options.delimiter ?? ',';
  const multiValueSeparator = options.multiValueSeparator ?? '; ';
  const toCell = (value: ProducedItemRecord[keyof ProducedItemRecord]): string => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(multiValueSeparator);
    return value;
  };
  const lines: string[] = [];
  lines.push(profile.map((f) => csvEscape(f.loadFileField, options)).join(delimiter));
  for (const record of records) {
    lines.push(profile.map((f) => csvEscape(toCell(record[f.source]), options)).join(delimiter));
  }
  return lines.join(CRLF) + CRLF;
}
