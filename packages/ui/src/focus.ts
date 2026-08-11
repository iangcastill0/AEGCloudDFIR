/**
 * Focus-trap helpers for the Dialog. The index math is pure so the wrap
 * behavior can be unit tested without a DOM.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'iframe',
  '[contenteditable="true"]',
].join(', ');

/**
 * Given the index of the currently focused element within the ordered list of
 * focusable elements inside the trap (-1 when focus is outside the list),
 * return the index that should receive focus for a Tab / Shift+Tab press —
 * or null when the browser's native order should be allowed to proceed.
 */
export function trapTargetIndex(
  activeIndex: number,
  count: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex === -1) {
    // Focus escaped the dialog (or sits on the container): pull it back in.
    return shiftKey ? count - 1 : 0;
  }
  if (shiftKey && activeIndex === 0) return count - 1;
  if (!shiftKey && activeIndex === count - 1) return 0;
  return null;
}

/**
 * Full focus order for a dialog trap: the sequence of indices focus visits
 * when Tab is pressed `presses` times starting at `startIndex`. Pure helper
 * used in tests to assert the cycle never leaves the trap.
 */
export function focusOrder(
  startIndex: number,
  count: number,
  presses: number,
  shiftKey = false,
): number[] {
  const order: number[] = [];
  let current = startIndex;
  for (let i = 0; i < presses; i += 1) {
    const wrapped = trapTargetIndex(current, count, shiftKey);
    if (wrapped !== null) {
      current = wrapped;
    } else {
      current = shiftKey ? current - 1 : current + 1;
    }
    order.push(current);
  }
  return order;
}
