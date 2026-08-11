import { describe, expect, it } from 'vitest';
import { focusOrder, trapTargetIndex } from './focus.js';

describe('trapTargetIndex (dialog focus trap)', () => {
  it('wraps Tab from the last element to the first', () => {
    expect(trapTargetIndex(2, 3, false)).toBe(0);
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    expect(trapTargetIndex(0, 3, true)).toBe(2);
  });

  it('lets the browser handle interior moves', () => {
    expect(trapTargetIndex(1, 3, false)).toBeNull();
    expect(trapTargetIndex(1, 3, true)).toBeNull();
  });

  it('pulls focus back inside when it escaped the dialog', () => {
    expect(trapTargetIndex(-1, 3, false)).toBe(0);
    expect(trapTargetIndex(-1, 3, true)).toBe(2);
  });

  it('does nothing for an empty dialog', () => {
    expect(trapTargetIndex(-1, 0, false)).toBeNull();
  });
});

describe('focusOrder', () => {
  it('cycles forward through every element and never leaves the trap', () => {
    const order = focusOrder(0, 3, 6, false);
    expect(order).toEqual([1, 2, 0, 1, 2, 0]);
    expect(order.every((i) => i >= 0 && i < 3)).toBe(true);
  });

  it('cycles backward with shift', () => {
    expect(focusOrder(0, 3, 4, true)).toEqual([2, 1, 0, 2]);
  });
});
