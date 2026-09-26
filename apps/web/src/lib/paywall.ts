export const PAYWALL_TIERS = [
  { id: 'basic', name: 'Basic' },
  { id: 'pro', name: 'Pro' },
  { id: 'max', name: 'Max' },
] as const;

export type PaywallTierId = (typeof PAYWALL_TIERS)[number]['id'];

/** Features for each tier are filled in later. Keep the slot on the tier id. */
export const PAYWALL_FEATURES: Record<PaywallTierId, readonly string[]> = {
  basic: [],
  pro: [],
  max: [],
};

/**
 * True when Basic / Pro / Max can actually be purchased.
 *
 * Until checkout exists the wall's buttons only set local React state. Turning
 * the gate on in that state locked every self-serve creator and every
 * bootstrap admin out of the app with no way forward — invite-only members
 * skipped it, so the product looked fine for guests and broken for owners.
 */
export const PAYWALL_CHECKOUT_READY = false;

export function paywallCta(name: string): string {
  return `Get ${name}`;
}

/**
 * Whether the signed-in person must pick a plan before using the app.
 *
 * `invited` is the ACTIVE tenant's membership flag (not "invited anywhere").
 * Checkout must be ready too: a wall with dead buttons is a lockout, not a
 * plan picker.
 */
export function paywallApplies(invited: boolean, checkoutReady = PAYWALL_CHECKOUT_READY): boolean {
  if (!checkoutReady) return false;
  return !invited;
}
