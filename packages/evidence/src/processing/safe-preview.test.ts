import { describe, expect, it } from 'vitest';
import { buildSafeEmailPreview, buildTextPreview, filterStyleAttribute } from './safe-preview.js';

/** Extract every attribute value from the output html. */
function attributeValues(html: string): string[] {
  const values: string[] = [];
  const re = /[a-zA-Z-]+\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1] !== undefined) values.push(match[1]);
  }
  return values;
}

describe('buildSafeEmailPreview: active content', () => {
  it('removes and counts <script> including its body', () => {
    const result = buildSafeEmailPreview('<p>hi</p><script>alert(1)</script>');
    expect(result.html).toContain('hi');
    expect(result.html).not.toContain('script');
    expect(result.html).not.toContain('alert');
    expect(result.removedActiveContent).toBe(1);
  });

  it('strips onclick and every other on* handler', () => {
    const result = buildSafeEmailPreview('<p onclick="steal()" onmouseover="x()">text</p>');
    expect(result.html).toBe('<p>text</p>');
  });

  it('removes and counts forms and inputs', () => {
    const result = buildSafeEmailPreview(
      '<form action="https://phish.example.com"><input name="password"><button>go</button></form><p>keep</p>',
    );
    expect(result.html).not.toContain('form');
    expect(result.html).not.toContain('input');
    expect(result.html).not.toContain('phish');
    expect(result.html).toContain('keep');
    expect(result.removedActiveContent).toBe(3); // form + input + button
  });

  it('removes iframe/object/embed and counts each', () => {
    const result = buildSafeEmailPreview(
      '<iframe src="https://evil.example.com"></iframe><object data="x"></object><embed src="y"><p>ok</p>',
    );
    expect(result.html).toBe('<p>ok</p>');
    expect(result.removedActiveContent).toBe(3);
  });
});

describe('buildSafeEmailPreview: images', () => {
  it('removes remote http(s) images and counts them as blocked', () => {
    const result = buildSafeEmailPreview(
      '<img src="http://tracker.example.com/img.png"><img src="https://cdn.example.com/logo.png"><p>body</p>',
    );
    expect(result.html).toBe('<p>body</p>');
    expect(result.blockedRemoteResources).toBe(2);
  });

  it('kills 1x1 tracking pixels', () => {
    const result = buildSafeEmailPreview(
      '<p>text</p><img src="https://track.example.com/open?id=abc" width="1" height="1">',
    );
    expect(result.html).toBe('<p>text</p>');
    expect(result.blockedRemoteResources).toBe(1);
  });

  it('removes protocol-relative and data: images', () => {
    const result = buildSafeEmailPreview(
      '<img src="//evil.example.com/x.png"><img src="data:image/png;base64,AAAA">',
    );
    expect(result.html).not.toContain('img');
    expect(result.blockedRemoteResources).toBe(2);
  });

  it('resolves allowed cid: images through the resolver', () => {
    const result = buildSafeEmailPreview('<img src="cid:diagram-1@example.com" alt="diagram">', {
      allowedCidResolver: (cid) =>
        cid === 'diagram-1@example.com' ? '/derivatives/cdfir-1/inline/diagram.png' : null,
    });
    expect(result.html).toContain('src="/derivatives/cdfir-1/inline/diagram.png"');
    expect(result.html).toContain('alt="diagram"');
    expect(result.blockedRemoteResources).toBe(0);
  });

  it('removes unresolvable cid images', () => {
    const result = buildSafeEmailPreview('<img src="cid:unknown@example.com"><p>x</p>', {
      allowedCidResolver: () => null,
    });
    expect(result.html).toBe('<p>x</p>');
  });

  it('removes cid images when no resolver is provided', () => {
    const result = buildSafeEmailPreview('<img src="cid:a@example.com">');
    expect(result.html).not.toContain('img');
  });
});

describe('buildSafeEmailPreview: links', () => {
  it('keeps http(s)/mailto hrefs but hardens them', () => {
    const result = buildSafeEmailPreview('<a href="https://example.com/doc">doc</a>');
    expect(result.html).toContain('href="https://example.com/doc"');
    expect(result.html).toContain('rel="noopener noreferrer"');
    expect(result.html).toContain('target="_blank"');
  });

  it('strips javascript: hrefs but keeps the anchor text', () => {
    const result = buildSafeEmailPreview('<a href="javascript:alert(1)">click me</a>');
    expect(result.html).toContain('click me');
    expect(result.html).not.toContain('javascript');
    expect(result.html).not.toContain('href');
  });

  it('strips obfuscated schemes', () => {
    const result = buildSafeEmailPreview('<a href="  jAvAsCrIpT:alert(1)">x</a>');
    expect(result.html).not.toContain('href');
  });
});

describe('buildSafeEmailPreview: styles', () => {
  it('keeps allowlisted properties', () => {
    const result = buildSafeEmailPreview(
      '<p style="color: red; font-weight: bold; margin-top: 4px">x</p>',
    );
    // sanitize-html normalizes declaration spacing on output.
    expect(result.html).toMatch(/color:\s*red/);
    expect(result.html).toMatch(/font-weight:\s*bold/);
    expect(result.html).toMatch(/margin-top:\s*4px/);
  });

  it('rejects url() values (remote background fetch)', () => {
    const result = buildSafeEmailPreview(
      '<p style="background-color:url(http://evil.example.com/x)">x</p>',
    );
    expect(result.html).not.toContain('url');
    expect(result.html).not.toContain('evil');
  });

  it('drops non-allowlisted properties and position:fixed overlays', () => {
    const result = buildSafeEmailPreview('<p style="position:fixed; top:0; color:blue">x</p>');
    expect(result.html).not.toContain('position');
    expect(result.html).not.toContain('fixed');
  });
});

describe('filterStyleAttribute', () => {
  it('filters to the allowlist', () => {
    expect(filterStyleAttribute('color: red; display: none; padding: 2px')).toBe(
      'color: red; padding: 2px',
    );
  });

  it('rejects expression() and @import values', () => {
    expect(filterStyleAttribute('color: expression(alert(1))')).toBe('');
    expect(filterStyleAttribute("font-family: @import 'x'")).toBe('');
  });
});

describe('buildSafeEmailPreview: output never references remote resources', () => {
  it('contains no http:// or https:// in any attribute', () => {
    const hostile = [
      '<img src="https://tracker.example.com/1x1.gif" width="1" height="1">',
      '<img src="HTTP://LOUD.example.com/x.png">',
      '<img src="//proto-relative.example.com/y.png">',
      '<img src="cid:inline-1@example.com">',
      '<p style="background-color: url(https://css.example.com/bg.png)">text</p>',
      '<table background="https://old-school.example.com/bg.gif"><tr><td>cell</td></tr></table>',
      '<form action="https://phish.example.com/submit"><input value="x"></form>',
    ].join('');
    const result = buildSafeEmailPreview(hostile, {
      allowedCidResolver: () => '/derivatives/ok.png',
    });
    for (const value of attributeValues(result.html)) {
      expect(value).not.toMatch(/https?:\/\//i);
    }
    // Belt and braces: nothing remote anywhere in the output.
    expect(result.html).not.toMatch(/https?:\/\//i);
    expect(result.blockedRemoteResources).toBeGreaterThanOrEqual(3);
    expect(result.removedActiveContent).toBeGreaterThanOrEqual(2);
  });
});

describe('buildTextPreview', () => {
  it('prefers the plain body', () => {
    expect(buildTextPreview('plain text', '<p>html</p>')).toBe('plain text');
  });

  it('falls back to converted html', () => {
    expect(buildTextPreview('', '<p>from html</p>')).toBe('from html');
    expect(buildTextPreview('   ', '<p>from html</p>')).toBe('from html');
  });

  it('returns empty string when nothing is available', () => {
    expect(buildTextPreview('', null)).toBe('');
    expect(buildTextPreview('', '')).toBe('');
  });
});
