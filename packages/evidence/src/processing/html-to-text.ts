/**
 * Small deterministic HTML → text converter used for indexing when an email
 * has no text/plain body. Intentionally dependency free so that the output
 * is stable across upgrades of third-party sanitizers.
 *
 * Never fetches anything: this is pure string manipulation.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

/** Decode the common named entities plus numeric (decimal/hex) references. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+|#39);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Convert HTML to plain text suitable for search indexing:
 * - script/style/head blocks removed entirely (content included),
 * - block-level boundaries (<br>, <p>, <div>, <li>, <tr>, headings, ...)
 *   become newlines,
 * - remaining tags stripped,
 * - entities decoded,
 * - whitespace collapsed (runs of spaces/tabs to one space, 3+ newlines to 2).
 */
export function htmlToText(html: string): string {
  let text = html;

  // Remove comments first so commented-out markup never leaks into text.
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove script/style/head/title blocks including their contents.
  text = text.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Block boundaries become newlines (both open and close tags so that
  // adjacent blocks separate even in malformed markup).
  text = text.replace(
    /<\/?(?:br|p|div|li|tr|table|ul|ol|h[1-6]|blockquote|pre|section|article|header|footer)\b[^>]*\/?>/gi,
    '\n',
  );

  // Table cells become single spaces so columns do not concatenate.
  text = text.replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ');

  // Strip every remaining tag.
  text = text.replace(/<[^>]*>/g, '');

  text = decodeEntities(text);

  // Normalize whitespace: unify newlines, collapse horizontal runs,
  // trim line edges, cap blank runs at one empty line.
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
