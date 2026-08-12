#!/usr/bin/env tsx
/**
 * DEMO MODE ONLY: run the local fake Microsoft/Google provider server used
 * for evaluation and tests. It serves sanitized fixtures from
 * packages/connectors/fixtures and never talks to real providers.
 *
 *   pnpm tsx scripts/demo-provider.ts        # listens on 4010
 */
import { join } from 'node:path';
import { startFakeProviderServer } from '@aeg-clouddfir/connectors/fake';

async function main(): Promise<void> {
  // Run from the repo root (documented in README).
  const fixtures = join(process.cwd(), 'packages', 'connectors', 'fixtures');

  const server = await startFakeProviderServer(fixtures, 4010);
  console.log(`[demo] fake provider server listening at ${server.url}`);
  console.log('[demo] point AEG-CloudDFIR at it via .env:');
  console.log(`  CDFIR_DEMO_MODE=true`);
  console.log(`  CDFIR_MS_GRAPH_BASE_URL=${server.url}/graph`);
  console.log(`  CDFIR_MS_LOGIN_BASE_URL=${server.url}`);
  console.log(`  CDFIR_GOOGLE_API_BASE_URL=${server.url}/google`);
  console.log(`  CDFIR_GOOGLE_OAUTH_TOKEN_URL=${server.url}/token`);

  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error('demo-provider failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
