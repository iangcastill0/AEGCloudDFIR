#!/usr/bin/env tsx
/**
 * DEMO MODE ONLY: run the local fake Microsoft/Google provider server used
 * for evaluation and tests. It serves sanitized fixtures from
 * packages/connectors/fixtures and never talks to real providers.
 *
 *   pnpm tsx scripts/demo-provider.ts        # listens on 4010
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFakeProviderServer } from '@evidencevault/connectors/fake';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'packages', 'connectors', 'fixtures');

const server = await startFakeProviderServer(fixtures, 4010);
console.log(`[demo] fake provider server listening at ${server.url}`);
console.log('[demo] point EvidenceVault at it via .env:');
console.log(`  EV_DEMO_MODE=true`);
console.log(`  EV_MS_GRAPH_BASE_URL=${server.url}/graph`);
console.log(`  EV_MS_LOGIN_BASE_URL=${server.url}`);
console.log(`  EV_GOOGLE_API_BASE_URL=${server.url}/google`);
console.log(`  EV_GOOGLE_OAUTH_TOKEN_URL=${server.url}/token`);

process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
