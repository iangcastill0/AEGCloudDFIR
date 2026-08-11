import { collectionScope, type CollectionScope } from '@evidencevault/contracts';
import type { DiscoveredMailFolder } from '@evidencevault/connectors';

/** Parse the Collection.scope JSON column into the validated contract shape. */
export function parseCollectionScope(raw: unknown): CollectionScope {
  return collectionScope.parse(raw);
}

export interface ScopeInstants {
  /** Inclusive UTC lower bound, or null for all_time. */
  since: string | null;
  /** EXCLUSIVE UTC upper bound (start of the day after endDate in the scope timezone), or null. */
  untilExclusive: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function splitDate(date: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(date);
  if (!match) throw new TypeError(`invalid calendar date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** Calendar-date arithmetic in pure UTC space (safe: no DST at this layer). */
export function addDays(date: string, days: number): string {
  const { y, m, d } = splitDate(date);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function wallClockInZone(instant: Date, timeZone: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    y: parts['year'] ?? 0,
    m: parts['month'] ?? 0,
    d: parts['day'] ?? 0,
    // Intl can render midnight as 24 with hour12:false in some engines.
    h: (parts['hour'] ?? 0) % 24,
    min: parts['minute'] ?? 0,
    s: parts['second'] ?? 0,
  };
}

/**
 * The UTC instant of local midnight (00:00:00.000) of `date` in `timeZone`.
 * Iterative offset correction handles DST transitions; a nonexistent local
 * midnight (spring-forward) resolves to the first valid following instant.
 */
export function zonedMidnightUtc(date: string, timeZone: string): Date {
  const { y, m, d } = splitDate(date);
  const desired = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let guess = desired;
  for (let i = 0; i < 4; i += 1) {
    const wall = wallClockInZone(new Date(guess), timeZone);
    const asUtc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.min, wall.s);
    const diff = desired - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/**
 * Convert the scope date range (inclusive calendar dates in the scope
 * timezone) to UTC instants: since = startDate 00:00 in tz (inclusive),
 * untilExclusive = (endDate + 1 day) 00:00 in tz (exclusive).
 */
export function dateRangeToInstants(scope: Pick<CollectionScope, 'dateRange'>): ScopeInstants {
  if (scope.dateRange.kind === 'all_time') {
    return { since: null, untilExclusive: null };
  }
  const { startDate, endDate, timezone } = scope.dateRange;
  return {
    since: zonedMidnightUtc(startDate, timezone).toISOString(),
    untilExclusive: zonedMidnightUtc(addDays(endDate, 1), timezone).toISOString(),
  };
}

/** Well-known folder / label filtering for email discovery. */
export function emailFolderIncluded(
  folder: DiscoveredMailFolder,
  provider: 'microsoft' | 'google',
  emailScope: NonNullable<CollectionScope['email']>,
): boolean {
  if (emailScope.folderIds !== null) {
    return emailScope.folderIds.includes(folder.id);
  }
  if (provider === 'google') {
    if (!emailScope.includeSpam && folder.wellKnown === 'SPAM') return false;
    if (!emailScope.includeTrash && folder.wellKnown === 'TRASH') return false;
    return true;
  }
  // Microsoft Graph: the connector marks recoverable-items with wellKnown;
  // Deleted Items / Junk Email are identified by their well-known display names.
  const name = folder.displayName.toLowerCase();
  if (
    !emailScope.includeRecoverableItems &&
    folder.wellKnown !== undefined &&
    folder.wellKnown.startsWith('recoverableitems')
  ) {
    return false;
  }
  if (!emailScope.includeTrash && (name === 'deleted items' || folder.wellKnown === 'deleteditems')) {
    return false;
  }
  if (!emailScope.includeSpam && (name === 'junk email' || folder.wellKnown === 'junkemail')) {
    return false;
  }
  return true;
}
