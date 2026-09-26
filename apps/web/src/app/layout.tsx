import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@aeg-clouddfir/ui/styles.css';
import './globals.css';
import { Providers } from '@/components/Providers';
import { AppNav } from '@/components/AppNav';
import { PaywallGate } from '@/components/PaywallGate';

export const metadata: Metadata = {
  title: { default: 'AEG-CloudDFIR', template: '%s — AEG-CloudDFIR' },
  description: 'Multi-provider forensic archive and eDiscovery review workspace',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <Providers>
          <AppNav />
          <main id="main" tabIndex={-1} className="app-main">
            <PaywallGate>{children}</PaywallGate>
          </main>
        </Providers>
      </body>
    </html>
  );
}
