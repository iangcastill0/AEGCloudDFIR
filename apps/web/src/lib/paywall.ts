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

export function paywallCta(name: string): string {
  return `Get ${name}`;
}

/** Invite and join-link members skip the wall. Everyone else who is signed in sees it. */
export function paywallApplies(invited: boolean): boolean {
  return !invited;
}
