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

/**
 * Milliseconds already spent, as "3 d 21 h 13 m".
 *
 * ELAPSED only. There is deliberately no formatter for a remaining time
 * anywhere in this app: replaying the biggest real collection (93.22 hours), a
 * 5-minute measurement window predicted the rest of the run between -16% and
 * +33% of the truth and a 30-minute window between -25% and +68%. A number that
 * wrong, shown to someone deciding whether to wait, is worse than no number.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 m';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes === 0) return `${String(Math.floor(ms / 1000))} s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)} d`);
  if (hours > 0) parts.push(`${String(hours)} h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${String(minutes)} m`);
  return parts.join(' ');
}

/**
 * A measured rate, or an honest dash.
 *
 * null means "not measured yet" and must NOT render as 0. A zero pace on screen
 * reads as stalled, and calling a collection that has simply not been running a
 * full minute stalled is the false alarm that teaches people to ignore alarms.
 */
export function formatRate(perMinute: number | null, unit: string): string {
  // `Number.isFinite(null)` is already false, so the explicit null check looks
  // redundant — it is not. It is what narrows the type for the arithmetic below;
  // `Number.isFinite` takes `unknown` and narrows nothing.
  if (perMinute === null || !Number.isFinite(perMinute)) return '—';
  const rounded = perMinute >= 10 ? Math.round(perMinute) : Math.round(perMinute * 10) / 10;
  return `${String(rounded)} ${unit}/min`;
}
