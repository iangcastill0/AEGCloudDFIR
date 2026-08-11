import { describe, expect, it } from 'vitest';
import { parseHighlight } from './highlight';

describe('parseHighlight', () => {
  it('splits on <mark> tokens only', () => {
    expect(parseHighlight('the <mark>wire transfer</mark> was sent')).toEqual([
      { text: 'the ', marked: false },
      { text: 'wire transfer', marked: true },
      { text: ' was sent', marked: false },
    ]);
  });

  it('handles multiple marks and adjacent marks', () => {
    expect(parseHighlight('<mark>a</mark><mark>b</mark> c')).toEqual([
      { text: 'a', marked: true },
      { text: 'b', marked: true },
      { text: ' c', marked: false },
    ]);
  });

  it('never lets other HTML through as markup — it stays literal text', () => {
    const segments = parseHighlight('x <script>alert(1)</script> <mark>hit</mark> <b>bold</b>');
    expect(segments).toEqual([
      { text: 'x <script>alert(1)</script> ', marked: false },
      { text: 'hit', marked: true },
      { text: ' <b>bold</b>', marked: false },
    ]);
    // the script tag is inside a plain-text segment, not interpreted
    expect(segments.some((s) => s.marked && s.text.includes('script'))).toBe(false);
  });

  it('treats an unclosed <mark> as marked-to-end and stray close as literal-safe', () => {
    expect(parseHighlight('start <mark>unclosed')).toEqual([
      { text: 'start ', marked: false },
      { text: 'unclosed', marked: true },
    ]);
    expect(parseHighlight('no open</mark> here')).toEqual([
      { text: 'no open</mark> here', marked: false },
    ]);
  });

  it('handles empty and mark-free strings', () => {
    expect(parseHighlight('')).toEqual([]);
    expect(parseHighlight('plain text')).toEqual([{ text: 'plain text', marked: false }]);
  });

  it('does not treat attribute-bearing mark tags as tokens', () => {
    expect(parseHighlight('<mark class="x">y</mark>')).toEqual([
      { text: '<mark class="x">y</mark>', marked: false },
    ]);
  });
});
