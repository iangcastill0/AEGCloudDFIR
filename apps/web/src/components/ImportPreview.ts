import { createElement, type ReactElement } from 'react';

export function CrushPreview({
  viewerType,
  value,
}: {
  viewerType: string;
  value: unknown;
}): ReactElement | null {
  if (value === null || value === undefined) return null;
  if (!['tree', 'tree_text', 'table', 'text', 'log'].includes(viewerType)) return null;
  return createElement(
    'pre',
    { style: { maxHeight: '28rem', overflow: 'auto', whiteSpace: 'pre-wrap' } },
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

export function SafeEvidencePreview({
  preview,
}: {
  preview: { kind: string; content?: string; imageUrls?: string[] } | undefined;
}): ReactElement | null {
  if (!preview || preview.kind === 'none') return null;
  if (preview.kind === 'image') {
    return createElement(
      'div',
      null,
      ...(preview.imageUrls ?? []).map((url) =>
        createElement('img', {
          key: url,
          src: url,
          alt: 'Safe generated preview',
          style: { maxWidth: '100%' },
        }),
      ),
    );
  }
  if (preview.kind === 'safe_html') {
    return createElement('iframe', {
      title: 'Safe generated preview',
      sandbox: '',
      srcDoc: preview.content ?? '',
      style: { width: '100%', minHeight: '28rem' },
    });
  }
  return createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, preview.content);
}
