/** Small display formatters shared across pages. */

export function formatBytes(size: string | number): string {
  const n = typeof size === 'string' ? Number(size) : size;
  if (!Number.isFinite(n) || n < 0) return String(size);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Replace status_like_this with "status like this" for display next to pills. */
export function humanizeToken(token: string): string {
  return token.replaceAll('_', ' ');
}
