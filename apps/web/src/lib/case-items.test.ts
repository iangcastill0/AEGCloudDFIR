import { describe, expect, it } from 'vitest';
import { addItemsMessage } from './case-items';

describe('addItemsMessage', () => {
  it('says how many were added', () => {
    expect(addItemsMessage({ requested: 49, added: 49 })).toBe('Added 49 item(s) to the case.');
  });

  it('separates new from already-present, rather than reporting one number', () => {
    expect(addItemsMessage({ requested: 49, added: 10 })).toBe(
      'Added 10 item(s). 39 were already in the case.',
    );
  });

  it('distinguishes "all were already there" from "nothing matched"', () => {
    // These two look identical as "added: 0", and reading them the same way is
    // how a broken selection passes for a duplicate add.
    expect(addItemsMessage({ requested: 49, added: 0 })).toBe(
      'No new items added — all 49 were already in the case.',
    );
    expect(addItemsMessage({ requested: 0, added: 0 })).toBe(
      'Nothing matched that selection, so no items were added.',
    );
  });

  it('uses the singular-safe "item(s)" form for one item', () => {
    expect(addItemsMessage({ requested: 1, added: 1 })).toBe('Added 1 item(s) to the case.');
  });
});
