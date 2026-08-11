/**
 * Roving-tabindex keyboard model (WAI-ARIA APG). Pure so it can be unit
 * tested without a DOM. Returns the next active index for a key press, or
 * null when the key is not part of the roving model.
 */
export type Orientation = 'horizontal' | 'vertical';

export function nextRovingIndex(
  current: number,
  count: number,
  key: string,
  orientation: Orientation = 'horizontal',
): number | null {
  if (count <= 0) return null;
  const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const clamped = Math.min(Math.max(current, 0), count - 1);
  switch (key) {
    case forward:
      return (clamped + 1) % count;
    case backward:
      return (clamped - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export interface RovingState {
  activeIndex: number;
  count: number;
}

export type RovingAction =
  | { type: 'key'; key: string; orientation?: Orientation }
  | { type: 'focus'; index: number }
  | { type: 'setCount'; count: number };

/** Reducer form used by the Tabs component and unit tests. */
export function rovingReducer(state: RovingState, action: RovingAction): RovingState {
  switch (action.type) {
    case 'key': {
      const next = nextRovingIndex(
        state.activeIndex,
        state.count,
        action.key,
        action.orientation ?? 'horizontal',
      );
      return next === null ? state : { ...state, activeIndex: next };
    }
    case 'focus': {
      if (action.index < 0 || action.index >= state.count) return state;
      return { ...state, activeIndex: action.index };
    }
    case 'setCount': {
      const count = Math.max(0, action.count);
      return {
        count,
        activeIndex: count === 0 ? 0 : Math.min(state.activeIndex, count - 1),
      };
    }
  }
}
