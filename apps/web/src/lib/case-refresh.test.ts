import { describe, expect, it } from 'vitest';
import { caseContentQueryKeys } from './hooks';

const CASE = '00000000-0000-4000-8000-0000000000aa';

describe('caseContentQueryKeys — what must refresh when a case gains items', () => {
  it('includes the two panels a reviewer reads after adding', () => {
    const keys = caseContentQueryKeys(CASE).map((k) => k.join(':'));
    // These two were missing, which is why the counts and the history only
    // caught up after a full page reload.
    expect(keys).toContain(`case-summary:${CASE}`);
    expect(keys).toContain(`case-activity:${CASE}`);
  });

  it('includes the item list, the tag set, the case itself and the case list', () => {
    const keys = caseContentQueryKeys(CASE).map((k) => k.join(':'));
    expect(keys).toContain(`case-items:${CASE}`);
    expect(keys).toContain(`case-tags:${CASE}`);
    expect(keys).toContain(`case:${CASE}`);
    expect(keys).toContain('cases');
  });

  it('scopes every case-specific key to this case, never all cases', () => {
    for (const key of caseContentQueryKeys(CASE)) {
      if (key[0] === 'cases') continue;
      expect(key[1]).toBe(CASE);
    }
  });
});
