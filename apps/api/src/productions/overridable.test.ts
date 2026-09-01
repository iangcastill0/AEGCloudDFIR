import { describe, expect, it } from 'vitest';
import { FLAG_DEFINITIONS } from '@aeg-clouddfir/production';

/**
 * The rule the submit endpoint now enforces, pinned here so a future flag
 * cannot quietly become acknowledgeable.
 *
 * Before this, nothing enforced `overridable: false` at all. The submit
 * endpoint required an acknowledgement for every blocking flag and never
 * checked whether the flag was allowed to be overridden — the rule lived only
 * in the fact that the web page withheld the checkbox. A client posting the
 * code by hand could have produced items flagged as malware.
 */
describe('flags that must never be overridable', () => {
  it('malware stays non-overridable', () => {
    // Producing known malware to opposing counsel is not a decision an
    // acknowledgement checkbox should be able to make.
    expect(FLAG_DEFINITIONS.malware_item.overridable).toBe(false);
    expect(FLAG_DEFINITIONS.malware_item.severity).toBe('blocking');
  });

  it('a bates collision stays non-overridable', () => {
    // Two productions sharing a bates range makes both unciteable.
    expect(FLAG_DEFINITIONS.duplicate_bates_range.overridable).toBe(false);
  });

  it('unresolved preview redactions stay non-overridable', () => {
    // Releasing a document whose redactions were never burned in is the worst
    // possible disclosure failure.
    expect(FLAG_DEFINITIONS.preview_redactions_in_release.overridable).toBe(false);
  });

  it('every non-overridable flag is at least blocking', () => {
    // A warning nobody can override would be an unexplainable dead end.
    for (const [code, def] of Object.entries(FLAG_DEFINITIONS)) {
      if (def.overridable) continue;
      expect(
        def.severity === 'blocking' || def.severity === 'security_critical',
        `${code} is not overridable but only ${def.severity}`,
      ).toBe(true);
    }
  });

  it('the flags in tonight’s production are classified as expected', () => {
    // family_split and unprocessed_item are judgement calls a reviewer may
    // knowingly accept; malware is not.
    expect(FLAG_DEFINITIONS.family_split.overridable).toBe(true);
    expect(FLAG_DEFINITIONS.unprocessed_item.overridable).toBe(true);
    expect(FLAG_DEFINITIONS.malware_item.overridable).toBe(false);
  });
});
