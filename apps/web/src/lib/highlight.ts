/**
 * Search-snippet highlight parsing. The API returns snippet strings where
 * matched terms are wrapped in literal <mark>…</mark> tokens. We split ONLY
 * on those two tokens and render everything else as plain text — arbitrary
 * HTML in the snippet is never interpreted.
 */
export interface HighlightSegment {
  text: string;
  marked: boolean;
}

const OPEN = '<mark>';
const CLOSE = '</mark>';

export function parseHighlight(snippet: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let rest = snippet;
  let marked = false;
  while (rest.length > 0) {
    const token = marked ? CLOSE : OPEN;
    const idx = rest.indexOf(token);
    if (idx === -1) {
      segments.push({ text: rest, marked });
      break;
    }
    if (idx > 0) segments.push({ text: rest.slice(0, idx), marked });
    rest = rest.slice(idx + token.length);
    marked = !marked;
  }
  return segments.filter((s) => s.text.length > 0);
}
