import { describe, expect, it } from 'vitest';
import { describeCaseEvent } from './case-activity.js';

describe('describeCaseEvent', () => {
  it('describes items added, naming where they came from', () => {
    expect(
      describeCaseEvent('case.items_added', { added: 12, requested: 12, sourceKind: 'collection' }),
    ).toBe('12 items added from a collection');
  });

  it('says when some were already there, so "0 added" is not read as a failure', () => {
    expect(
      describeCaseEvent('case.items_added', { added: 0, requested: 5, sourceKind: 'tag' }),
    ).toBe('0 items added from a tag (5 already in the case)');
  });

  it('uses the singular for one item', () => {
    expect(
      describeCaseEvent('case.items_added', { added: 1, requested: 1, sourceKind: 'manual' }),
    ).toBe('1 item added from a manual');
  });

  it('reads a saved_search source as words', () => {
    expect(
      describeCaseEvent('case.items_added', { added: 3, requested: 3, sourceKind: 'saved_search' }),
    ).toContain('from a saved search');
  });

  it('reports legal hold in both directions, with the reason', () => {
    expect(describeCaseEvent('case.hold_changed', { legalHold: true, reason: 'litigation' })).toBe(
      'Legal hold placed: litigation',
    );
    expect(describeCaseEvent('case.hold_changed', { legalHold: false, reason: '' })).toBe(
      'Legal hold lifted',
    );
  });

  it('names the person for membership changes', () => {
    expect(describeCaseEvent('case.member_added', { memberEmail: 'a@b.test' })).toBe(
      'a@b.test added to the case',
    );
    expect(describeCaseEvent('case.member_removed', {})).toBe('Member removed');
  });

  it('falls back to the action name for anything unrecognised', () => {
    // The audit log is append-only, so old events can predate today's wording.
    expect(describeCaseEvent('export.created', { anything: 1 })).toBe('export.created');
  });

  it('survives a summary that is not an object', () => {
    for (const bad of [null, undefined, 'text', 42, []]) {
      expect(describeCaseEvent('case.items_added', bad)).toBe('Items added');
    }
  });
});
