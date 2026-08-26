/**
 * Make provider text safe to store in PostgreSQL.
 *
 * Postgres rejects a NUL byte in any text column: `invalid byte sequence for
 * encoding "UTF8": 0x00`. Real mail contains them — two messages in a 29,000
 * message Gmail collection killed `emailMetadata.upsert` and left their items
 * preserved but never parsed.
 *
 * NUL is dropped rather than replaced: it carries no meaning in a header or a
 * filename, and substituting a visible character would change text a reviewer
 * may later quote. The evidence itself is untouched — the original bytes are
 * already preserved and hashed. This only cleans the copy stored in the database
 * for search and display.
 *
 * Only NUL is removed. Tabs and newlines are legal in Postgres text, and
 * stripping them would silently alter evidence.
 */

/**
 * Written as fromCharCode rather than a literal or an escape: a literal NUL in
 * source is invisible in every editor and diff, and that is not a thing to hide
 * in a file about handling it.
 */
const NUL = String.fromCharCode(0);

/** Strip the one character PostgreSQL cannot store in a text column. */
export function pgText(value: string): string {
  return value.split(NUL).join('');
}

/** pgText for an optional value; null and undefined stay null. */
export function pgTextOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return pgText(value);
}

/** pgText across an array, dropping entries that were nothing but NUL. */
export function pgTextList(values: readonly string[]): string[] {
  return values.map(pgText).filter((v) => v !== '');
}
