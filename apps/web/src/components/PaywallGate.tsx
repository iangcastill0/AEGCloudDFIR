'use client';
import type { ReactNode } from 'react';
import { Paywall } from '@/components/Paywall';
import { useMe } from '@/lib/hooks';
import { paywallApplies } from '@/lib/paywall';

/**
 * Signed-in people on an unpaid self-serve org see the plan wall — but only
 * once checkout can actually sell a plan. Until then the buttons are dead and
 * the gate would lock owners out of the product.
 */
export function PaywallGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data && paywallApplies(me.data.invited)) return <Paywall />;
  return children;
}
