import { describe, expect, it } from 'vitest';
import { formatDuration, formatRate } from './format';

describe('formatDuration — elapsed, never remaining', () => {
  it('formats the two real wall clocks of the biggest collection', () => {
    // 93.22 h whole run, 66.00 h acquisition, so a 27.22 h processing tail.
    expect(formatDuration(93.22 * 3600_000)).toBe('3 d 21 h 13 m');
    expect(formatDuration(66 * 3600_000)).toBe('2 d 18 h');
    expect(formatDuration(27.22 * 3600_000)).toBe('1 d 3 h 13 m');
  });

  it('drops units that are zero rather than printing "0 d 0 h"', () => {
    expect(formatDuration(5 * 60_000)).toBe('5 m');
    expect(formatDuration(2 * 3600_000)).toBe('2 h');
  });

  it('falls back to seconds under a minute, so a new run is not "0 m"', () => {
    expect(formatDuration(30_000)).toBe('30 s');
  });

  it('never returns a negative or NaN duration', () => {
    expect(formatDuration(-1)).toBe('0 m');
    expect(formatDuration(Number.NaN)).toBe('0 m');
    expect(formatDuration(0)).toBe('0 m');
  });
});

describe('formatRate — an unmeasured pace is a dash, not a zero', () => {
  it('shows a dash for null', () => {
    // A "0 items/min" on screen reads as stalled. Calling a 30-second-old
    // collection stalled is the false alarm that trains people to ignore alarms.
    expect(formatRate(null, 'items')).toBe('—');
    expect(formatRate(null, 'items')).not.toContain('0');
  });

  it('shows a real zero when zero is what was measured', () => {
    // Different claim entirely: a full measured minute that acquired nothing.
    expect(formatRate(0, 'items')).toBe('0 items/min');
  });

  it('rounds to whole numbers above ten and one decimal below', () => {
    expect(formatRate(101, 'items')).toBe('101 items/min');
    expect(formatRate(101.4, 'items')).toBe('101 items/min');
    expect(formatRate(1.44, 'items')).toBe('1.4 items/min');
  });

  it('carries the unit it was given', () => {
    expect(formatRate(54, 'items')).toBe('54 items/min');
    expect(formatRate(54, 'MB')).toBe('54 MB/min');
  });

  it('refuses a non-finite rate', () => {
    expect(formatRate(Number.POSITIVE_INFINITY, 'items')).toBe('—');
    expect(formatRate(Number.NaN, 'items')).toBe('—');
  });
});
