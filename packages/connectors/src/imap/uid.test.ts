import { describe, expect, it } from 'vitest';
import {
  decodeUidCursor,
  encodeUidCursor,
  nextUidRange,
  searchCriteria,
  UID_PAGE_SIZE,
  type UidCursor,
} from './uid';

describe('encodeUidCursor / decodeUidCursor', () => {
  it('round-trips a position within one mailbox generation', () => {
    const cursor: UidCursor = { uidValidity: '1234567890', lastUid: 4242 };
    expect(decodeUidCursor(encodeUidCursor(cursor))).toEqual(cursor);
  });

  it('returns null for a cursor that is not ours, instead of guessing', () => {
    for (const bad of ['', 'garbage', 'v1:notanumber:5', '{}', 'v1:1']) {
      expect(decodeUidCursor(bad)).toBeNull();
    }
  });
});

describe('nextUidRange', () => {
  /**
   * UIDVALIDITY is the whole safety story in IMAP. When a server changes it,
   * every UID a checkpoint holds refers to a different message — or to nothing.
   * Resuming from an old UID would silently skip mail, which for a collection is
   * the worst possible failure: a smaller, complete-looking result.
   */
  it('starts from the beginning when the mailbox generation changed', () => {
    const range = nextUidRange({
      uidValidity: '999',
      cursor: { uidValidity: '111', lastUid: 5000 },
    });
    expect(range).toEqual({ from: 1, to: UID_PAGE_SIZE, restarted: true });
  });

  it('starts from the beginning when there is no cursor', () => {
    expect(nextUidRange({ uidValidity: '999', cursor: null })).toEqual({
      from: 1,
      to: UID_PAGE_SIZE,
      restarted: false,
    });
  });

  it('continues after the last UID it finished', () => {
    expect(
      nextUidRange({ uidValidity: '999', cursor: { uidValidity: '999', lastUid: 100 } }),
    ).toEqual({ from: 101, to: 100 + UID_PAGE_SIZE, restarted: false });
  });

  it('never re-fetches the last UID, which would duplicate an item', () => {
    const range = nextUidRange({
      uidValidity: '999',
      cursor: { uidValidity: '999', lastUid: 1 },
    });
    expect(range.from).toBe(2);
  });
});

describe('searchCriteria', () => {
  it('asks for everything when no window is given', () => {
    expect(searchCriteria({})).toEqual({ all: true });
  });

  it('turns a since bound into an IMAP SINCE date', () => {
    // IMAP SINCE has DAY granularity and is inclusive. Rounding down is
    // deliberate: a tighter bound could drop mail inside the window the
    // operator asked for, and over-collecting inside a stated scope is safe
    // while under-collecting is not.
    const c = searchCriteria({ since: '2026-03-04T23:30:00.000Z' });
    expect(c.since).toEqual(new Date('2026-03-04T00:00:00.000Z'));
  });

  it('turns an until bound into an IMAP BEFORE date, one day past the bound', () => {
    // BEFORE is exclusive and day-granular, so a request "until the 4th" must
    // ask for BEFORE the 5th or the whole of the 4th is lost.
    const c = searchCriteria({ until: '2026-03-04T01:00:00.000Z' });
    expect(c.before).toEqual(new Date('2026-03-05T00:00:00.000Z'));
  });

  it('combines both bounds and drops the all flag', () => {
    const c = searchCriteria({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-01-31T00:00:00.000Z',
    });
    expect(c.all).toBeUndefined();
    expect(c.since).toBeDefined();
    expect(c.before).toBeDefined();
  });

  it('ignores a date it cannot parse rather than sending nonsense to the server', () => {
    expect(searchCriteria({ since: 'not-a-date' })).toEqual({ all: true });
  });
});
