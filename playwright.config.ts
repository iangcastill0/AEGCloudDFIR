import { defineConfig, devices } from '@playwright/test';

/**
 * E2E acceptance tests. Expect the local stack to be running:
 *   docker compose -f infra/compose/docker-compose.yml up -d
 *   (migrations applied, demo seed run, fake provider on :4010)
 *   api on :4000, web on :3000
 *
 * tests/e2e/global-setup.ts performs the Authentik login once and stores
 * authenticated browser state for all specs.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.CDFIR_E2E_WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});
