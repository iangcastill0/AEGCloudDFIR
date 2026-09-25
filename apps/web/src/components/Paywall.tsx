'use client';
import { useState } from 'react';
import { Button, StatusLive } from '@aeg-clouddfir/ui';
import { PAYWALL_FEATURES, PAYWALL_TIERS, paywallCta, type PaywallTierId } from '@/lib/paywall';

export function Paywall() {
  const [chosen, setChosen] = useState<PaywallTierId | null>(null);
  const chosenName = PAYWALL_TIERS.find((tier) => tier.id === chosen)?.name;

  return (
    <section className="paywall" aria-labelledby="paywall-heading">
      <h1 id="paywall-heading">Choose a plan</h1>
      <p>Pick Basic, Pro, or Max to continue. Each plan will list what it includes.</p>
      <StatusLive politeness="polite">{chosenName ? `You chose ${chosenName}.` : ''}</StatusLive>
      <div className="paywall-grid">
        {PAYWALL_TIERS.map((tier) => {
          const features = PAYWALL_FEATURES[tier.id];
          const selected = chosen === tier.id;
          return (
            <article
              key={tier.id}
              className={
                tier.id === 'pro' ? 'card paywall-tier paywall-tier--pro' : 'card paywall-tier'
              }
              aria-labelledby={`paywall-${tier.id}`}
            >
              <h2 id={`paywall-${tier.id}`}>{tier.name}</h2>
              {features.length > 0 ? (
                <ul>
                  {features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              ) : (
                <p className="paywall-tier__pending">Features for this plan will be listed here.</p>
              )}
              <Button
                variant={tier.id === 'pro' ? 'primary' : 'secondary'}
                aria-pressed={selected}
                onClick={() => setChosen(tier.id)}
              >
                {paywallCta(tier.name)}
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
