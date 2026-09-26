import { describe, expect, it } from 'vitest';
import { PAYWALL_FEATURES, PAYWALL_TIERS, paywallApplies, paywallCta } from './paywall';

describe('paywall tiers', () => {
  it('offers Basic, Pro, and Max in that order', () => {
    expect(PAYWALL_TIERS.map((tier) => tier.name)).toEqual(['Basic', 'Pro', 'Max']);
  });

  it('names each button Get plus the tier name', () => {
    expect(PAYWALL_TIERS.map((tier) => paywallCta(tier.name))).toEqual([
      'Get Basic',
      'Get Pro',
      'Get Max',
    ]);
  });

  it('keeps a feature list for each tier so later work can fill it', () => {
    expect(Object.keys(PAYWALL_FEATURES)).toEqual(['basic', 'pro', 'max']);
  });

  it('hides the wall for someone who joined from an invite link', () => {
    expect(paywallApplies(true)).toBe(false);
    expect(paywallApplies(false)).toBe(true);
  });
});
