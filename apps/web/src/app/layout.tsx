import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@evidencevault/ui/styles.css';
import './globals.css';
import { Providers } from '@/components/Providers';
import { AppNav } from '@/components/AppNav';

export const metadata: Metadata = {
  title: { default: 'EvidenceVault', template: '%s — EvidenceVault' },
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
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
