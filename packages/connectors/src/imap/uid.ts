/**
 * UID paging and search windows for IMAP.
 *
 * IMAP has no delta link. A mailbox is walked by UID, and the only resume token
 * that means anything is "(UIDVALIDITY, last UID I finished)". UIDVALIDITY is
 * the mailbox generation: when a server changes it, every stored UID points at
 * a different message, or at nothing. Resuming from a stale UID would silently
 * skip mail and still report success — a smaller, complete-looking collection,
 * which is the worst failure this product can have. So a changed UIDVALIDITY
 * restarts the walk from the beginning.
 *
 * Pure on purpose: none of this needs a server to test.
 */
import type { ListMessagesOptions } from '../types.js';

/** UIDs requested per page. Large enough to be efficient, small enough to checkpoint often. */
export const UID_PAGE_SIZE = 500;

export interface UidCursor {
  /** The mailbox generation these UIDs belong to. */
  uidValidity: string;
  /** Highest UID already collected AND checkpointed. */
  lastUid: number;
}

const CURSOR_PREFIX = 'v1';

export function encodeUidCursor(cursor: UidCursor): string {
  return `${CURSOR_PREFIX}:${cursor.uidValidity}:${String(cursor.lastUid)}`;
}

/** Parse a cursor, or null when it is not one of ours. Never guesses. */
export function decodeUidCursor(raw: string): UidCursor | null {
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return null;
  const [, uidValidity, lastUidRaw] = parts;
  if (uidValidity === undefined || lastUidRaw === undefined) return null;
  // UIDVALIDITY is a 32-bit unsigned number (RFC 3501), so anything else is not
  // a cursor we wrote. Accepting it would let a malformed value compare unequal
  // to every real generation and restart the walk on every single page.
  if (!/^\d+$/.test(uidValidity) || !/^\d+$/.test(lastUidRaw)) return null;
  return { uidValidity, lastUid: Number(lastUidRaw) };
}

export interface UidRange {
  from: number;
  to: number;
  /** True when a UIDVALIDITY change forced the walk back to the start. */
  restarted: boolean;
}

/** The next window of UIDs to ask for. */
export function nextUidRange(input: { uidValidity: string; cursor: UidCursor | null }): UidRange {
  const stale = input.cursor !== null && input.cursor.uidValidity !== input.uidValidity;
  if (input.cursor === null || stale) {
    return { from: 1, to: UID_PAGE_SIZE, restarted: stale };
  }
  const from = input.cursor.lastUid + 1;
  return { from, to: input.cursor.lastUid + UID_PAGE_SIZE, restarted: false };
}

export interface ImapSearchCriteria {
  all?: true;
  since?: Date;
  before?: Date;
}

function dayStart(iso: string): Date | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Translate a date window into IMAP SEARCH terms.
 *
 * IMAP dates are day-granular. SINCE is inclusive, BEFORE is exclusive, so an
 * `until` bound has to ask for the day AFTER it or the whole final day is lost.
 * Both bounds round outward: collecting slightly more than asked, inside a scope
 * the operator chose, is safe. Collecting less is not.
 */
export function searchCriteria(opts: ListMessagesOptions): ImapSearchCriteria {
  const criteria: ImapSearchCriteria = {};

  const since = opts.since === undefined ? null : dayStart(opts.since);
  if (since !== null) criteria.since = since;

  const until = opts.until === undefined ? null : dayStart(opts.until);
  if (until !== null) {
    criteria.before = new Date(until.getTime() + 24 * 60 * 60 * 1000);
  }

  if (criteria.since === undefined && criteria.before === undefined) {
    return { all: true };
  }
  return criteria;
}
