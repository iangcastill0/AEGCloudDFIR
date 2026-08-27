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
  /**
   * IMAP sequence string, always open-ended: `<from>:*`.
   *
   * Measured against a real Yahoo mailbox: 10,000 messages with UIDs from
   * 257,733 to 287,748. Fixed 500-wide windows starting at 1 meant 515 empty
   * round trips before the first message — UIDs are never reused, so any
   * long-lived mailbox looks like this, and a collection that spends minutes
   * finding nothing reads as hung. Asking for everything at or above the cursor
   * and keeping one page-worth skips the empty space entirely.
   */
  sequence: string;
  /** True when a UIDVALIDITY change forced the walk back to the start. */
  restarted: boolean;
}

/** Where the next page starts, as an open-ended UID range. */
export function nextUidRange(input: { uidValidity: string; cursor: UidCursor | null }): UidRange {
  const stale = input.cursor !== null && input.cursor.uidValidity !== input.uidValidity;
  const from = input.cursor === null || stale ? 1 : input.cursor.lastUid + 1;
  return { from, sequence: `${String(from)}:*`, restarted: stale };
}

export interface UidPage {
  /** The UIDs to fetch, in order. */
  uids: number[];
  /** Cursor for the next page, or null when this was the last one. */
  cursor: UidCursor | null;
}

/**
 * Take one page from the UIDs a search returned.
 *
 * A short result means the mailbox is exhausted: the search asked for everything
 * at or above `from`, so nothing remains above the last UID taken. Deciding
 * exhaustion from the result — rather than from UIDNEXT arithmetic — removes a
 * class of off-by-one that would either stop early (mail missed, collection
 * still reporting complete) or never stop at all.
 */
export function takeUidPage(input: {
  uidValidity: string;
  found: readonly number[];
  pageSize?: number;
}): UidPage {
  const size = input.pageSize ?? UID_PAGE_SIZE;
  const sorted = [...input.found].sort((a, b) => a - b);
  const uids = sorted.slice(0, size);
  const last = uids[uids.length - 1];
  const exhausted = sorted.length <= size;
  return {
    uids,
    cursor:
      exhausted || last === undefined ? null : { uidValidity: input.uidValidity, lastUid: last },
  };
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
