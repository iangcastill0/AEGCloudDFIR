import { describe, expect, it } from 'vitest';
import {
  PAYWALL_CHECKOUT_READY,
  PAYWALL_FEATURES,
  PAYWALL_TIERS,
  paywallApplies,
  paywallCta,
} from './paywall';

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

  it('does not hard-block the app until checkout can actually sell a plan', () => {
    // Self-serve creators and bootstrap admins have invited=false. With the
    // gate on and no purchase path, those people could not leave the wall.
    expect(PAYWALL_CHECKOUT_READY).toBe(false);
    expect(paywallApplies(false)).toBe(false);
    expect(paywallApplies(true)).toBe(false);
  });

  it('when checkout is ready, hides the wall only for invite / join-link members', () => {
    expect(paywallApplies(true, true)).toBe(false);
    expect(paywallApplies(false, true)).toBe(true);
  });
});
