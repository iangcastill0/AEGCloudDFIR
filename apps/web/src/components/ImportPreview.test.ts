import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrushPreview, SafeEvidencePreview } from './ImportPreview';

describe('ImportPreview', () => {
  it('renders bounded structured data as readable JSON', () => {
    const html = renderToStaticMarkup(
      createElement(CrushPreview, {
        viewerType: 'table',
        value: { events: { rows: [[1, 'login']] } },
      }),
    );
    expect(html).toContain('events');
    expect(html).toContain('login');
  });

  it('keeps generated HTML sandboxed and gives images text alternatives', () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(SafeEvidencePreview, {
          preview: { kind: 'safe_html', content: '<p>safe</p>' },
        }),
        createElement(SafeEvidencePreview, {
          preview: { kind: 'image', imageUrls: ['https://example.test/a'] },
        }),
      ),
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('alt="Safe generated preview"');
  });
});
