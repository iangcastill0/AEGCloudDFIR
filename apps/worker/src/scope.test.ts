import { describe, expect, it } from 'vitest';
import { addDays, dateRangeToInstants, emailFolderIncluded, zonedMidnightUtc } from './scope.js';

describe('dateRangeToInstants', () => {
  it('all_time yields null bounds', () => {
    expect(dateRangeToInstants({ dateRange: { kind: 'all_time' } })).toEqual({
      since: null,
      untilExclusive: null,
    });
  });

  it('converts inclusive calendar dates to tz-local midnights (UTC)', () => {
    const result = dateRangeToInstants({
      dateRange: { kind: 'range', startDate: '2026-01-10', endDate: '2026-01-10', timezone: 'UTC' },
    });
    expect(result.since).toBe('2026-01-10T00:00:00.000Z');
    // Inclusive end: the whole endDate day, so the bound is +1 day, exclusive.
    expect(result.untilExclusive).toBe('2026-01-11T00:00:00.000Z');
  });

  it('handles the America/Chicago spring-forward DST boundary', () => {
    // DST starts 2026-03-08 in Chicago: that calendar day is only 23h long.
    const result = dateRangeToInstants({
      dateRange: {
        kind: 'range',
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        timezone: 'America/Chicago',
      },
    });
    expect(result.since).toBe('2026-03-08T06:00:00.000Z'); // midnight CST (-6)
    expect(result.untilExclusive).toBe('2026-03-09T05:00:00.000Z'); // next midnight CDT (-5)
  });

  it('handles the America/Chicago fall-back DST boundary (25h day)', () => {
    const result = dateRangeToInstants({
      dateRange: {
        kind: 'range',
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        timezone: 'America/Chicago',
      },
    });
    expect(result.since).toBe('2026-11-01T05:00:00.000Z'); // midnight CDT (-5)
    expect(result.untilExclusive).toBe('2026-11-02T06:00:00.000Z'); // next midnight CST (-6)
  });
});

describe('date helpers', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('zonedMidnightUtc equals plain UTC midnight for UTC', () => {
    expect(zonedMidnightUtc('2026-06-15', 'UTC').toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('emailFolderIncluded', () => {
  const scope = {
    folderIds: null,
    includeSpam: false,
    includeTrash: false,
    includeRecoverableItems: false,
  };

  it('excludes Gmail SPAM/TRASH unless opted in', () => {
    const spam = { id: 'SPAM', displayName: 'Spam', wellKnown: 'SPAM', path: '/Spam' };
    expect(emailFolderIncluded(spam, 'google', scope)).toBe(false);
    expect(emailFolderIncluded(spam, 'google', { ...scope, includeSpam: true })).toBe(true);
  });

  it('excludes Graph recoverable items and deleted items unless opted in', () => {
    const recoverable = {
      id: 'r1',
      displayName: 'Deletions',
      wellKnown: 'recoverableitemsdeletions',
      path: '/Deletions',
    };
    const deleted = { id: 'd1', displayName: 'Deleted Items', path: '/Deleted Items' };
    expect(emailFolderIncluded(recoverable, 'microsoft', scope)).toBe(false);
    expect(
      emailFolderIncluded(recoverable, 'microsoft', { ...scope, includeRecoverableItems: true }),
    ).toBe(true);
    expect(emailFolderIncluded(deleted, 'microsoft', scope)).toBe(false);
    expect(emailFolderIncluded(deleted, 'microsoft', { ...scope, includeTrash: true })).toBe(true);
  });

  it('an explicit folder allowlist wins over flags', () => {
    const inbox = { id: 'inbox', displayName: 'Inbox', path: '/Inbox' };
    expect(emailFolderIncluded(inbox, 'microsoft', { ...scope, folderIds: ['other'] })).toBe(false);
    expect(emailFolderIncluded(inbox, 'microsoft', { ...scope, folderIds: ['inbox'] })).toBe(true);
  });
});
