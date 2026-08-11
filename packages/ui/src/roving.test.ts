import { describe, expect, it } from 'vitest';
import { nextRovingIndex, rovingReducer, type RovingState } from './roving.js';

describe('nextRovingIndex', () => {
  it('moves forward and wraps at the end (horizontal)', () => {
    expect(nextRovingIndex(0, 3, 'ArrowRight')).toBe(1);
    expect(nextRovingIndex(2, 3, 'ArrowRight')).toBe(0);
  });

  it('moves backward and wraps at the start', () => {
    expect(nextRovingIndex(1, 3, 'ArrowLeft')).toBe(0);
    expect(nextRovingIndex(0, 3, 'ArrowLeft')).toBe(2);
  });

  it('supports Home and End', () => {
    expect(nextRovingIndex(1, 5, 'Home')).toBe(0);
    expect(nextRovingIndex(1, 5, 'End')).toBe(4);
  });

  it('uses up/down in vertical orientation and ignores left/right', () => {
    expect(nextRovingIndex(0, 3, 'ArrowDown', 'vertical')).toBe(1);
    expect(nextRovingIndex(0, 3, 'ArrowUp', 'vertical')).toBe(2);
    expect(nextRovingIndex(0, 3, 'ArrowRight', 'vertical')).toBeNull();
  });

  it('returns null for unrelated keys and empty lists', () => {
    expect(nextRovingIndex(0, 3, 'Enter')).toBeNull();
    expect(nextRovingIndex(0, 0, 'ArrowRight')).toBeNull();
  });

  it('clamps an out-of-range current index before moving', () => {
    expect(nextRovingIndex(99, 3, 'ArrowRight')).toBe(0);
    expect(nextRovingIndex(-5, 3, 'ArrowLeft')).toBe(2);
  });
});

describe('rovingReducer', () => {
  const state: RovingState = { activeIndex: 1, count: 4 };

  it('applies handled keys and ignores others', () => {
    expect(rovingReducer(state, { type: 'key', key: 'ArrowRight' }).activeIndex).toBe(2);
    expect(rovingReducer(state, { type: 'key', key: 'a' })).toBe(state);
  });

  it('accepts focus moves only within range', () => {
    expect(rovingReducer(state, { type: 'focus', index: 3 }).activeIndex).toBe(3);
    expect(rovingReducer(state, { type: 'focus', index: 4 })).toBe(state);
    expect(rovingReducer(state, { type: 'focus', index: -1 })).toBe(state);
  });

  it('clamps the active index when the item count shrinks', () => {
    const shrunk = rovingReducer({ activeIndex: 3, count: 4 }, { type: 'setCount', count: 2 });
    expect(shrunk).toEqual({ activeIndex: 1, count: 2 });
    expect(rovingReducer(state, { type: 'setCount', count: 0 })).toEqual({
      activeIndex: 0,
      count: 0,
    });
  });
});
