'use client';
import type { ReactNode } from 'react';
import { Paywall } from '@/components/Paywall';
import { useMe } from '@/lib/hooks';
import { paywallApplies } from '@/lib/paywall';

/** Signed-in people see the plan wall, unless they joined from an invite link. */
export function PaywallGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data && paywallApplies(me.data.invited)) return <Paywall />;
  return children;
}
