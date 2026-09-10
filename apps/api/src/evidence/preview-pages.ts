/**
 * Object keys for every page of a rasterised preview.
 *
 * The worker writes `preview-page001.png` … `preview-pageNNN.png` and stores
 * only the first key on the Preview row, with `pageCount` beside it. Deriving
 * the rest here keeps one row per preview instead of one per page.
 *
 * Returns [] for anything that is not a numbered page sequence — an image or a
 * text preview is a single object and has no pages to walk.
 */
export function pageKeys(firstKey: string, pageCount: number): string[] {
  const match = /^(.*preview-page)(\d+)(\.png)$/.exec(firstKey);
  if (match === null || pageCount <= 1) return [];
  const [, prefix, digits, suffix] = match;
  const width = (digits ?? '').length;
  return Array.from(
    { length: pageCount },
    (_, i) => `${prefix ?? ''}${String(i + 1).padStart(width, '0')}${suffix ?? ''}`,
  );
}
