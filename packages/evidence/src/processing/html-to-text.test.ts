import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from './html-to-text.js';

describe('htmlToText', () => {
  it('converts block boundaries to newlines', () => {
    const text = htmlToText('<p>one</p><div>two</div>three<br>four<ul><li>five</li><li>six</li></ul>');
    expect(text.split('\n').filter((l) => l !== '')).toEqual([
      'one', 'two', 'three', 'four', 'five', 'six',
    ]);
  });

  it('separates table rows and cells', () => {
    const text = htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    expect(text).toContain('a b');
    expect(text).toContain('c d');
    expect(text.indexOf('a b')).toBeLessThan(text.indexOf('c d'));
  });

  it('strips script and style blocks including their contents', () => {
    const text = htmlToText(
      '<style>.x{color:red}</style><p>visible</p><script>alert("hidden")</script>',
    );
    expect(text).toBe('visible');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('drops html comments', () => {
    expect(htmlToText('a<!-- <p>secret</p> -->b')).toBe('ab');
  });

  it('decodes entities', () => {
    expect(htmlToText('&amp; &lt;tag&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b &#65; &#x42;')).toBe(
      '& <tag> "q" \'s\' a b A B',
    );
  });

  it('collapses whitespace runs', () => {
    const text = htmlToText('<p>  spaced\t\tout  </p>\n\n\n<p>next</p>');
    expect(text).toBe('spaced out\n\nnext');
  });
});

describe('decodeEntities', () => {
  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&unknown; &amp;')).toBe('&unknown; &');
  });

  it('rejects out-of-range numeric references', () => {
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
  });
});
