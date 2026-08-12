import { expect, test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const API = process.env.CDFIR_E2E_API_URL ?? 'http://localhost:4000';
const AUTHENTIK_USER = process.env.CDFIR_E2E_IDP_USER ?? 'akadmin';
const AUTHENTIK_PASSWORD = process.env.CDFIR_E2E_IDP_PASSWORD ?? 'admin-local-only';

/**
 * Logs in once through the real Authentik flow (code + PKCE) and persists
 * storage state (session cookie) for every spec.
 */
setup('authenticate via Authentik', async ({ page }) => {
  mkdirSync('tests/e2e/.auth', { recursive: true });

  await page.goto(`${API}/auth/login?redirectTo=/`);
  // Authentik identification stage (labels are visual only, so use roles)
  await page.getByRole('textbox', { name: /email or username|username/i }).fill(AUTHENTIK_USER);
  await page.getByRole('button', { name: /log in|continue/i }).click();
  const passwordField = page.getByRole('textbox', { name: /password/i });
  await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
  await passwordField.fill(AUTHENTIK_PASSWORD);
  await page.getByRole('button', { name: /log in|continue/i }).click();

  // Back on the web app after the BFF callback.
  await page.waitForURL(/localhost:3000/, { timeout: 30_000 });

  // Session is established; /api/v1/me responds.
  const me = await page.request.get(`${API}/api/v1/me`);
  expect(me.ok()).toBeTruthy();

  await page.context().storageState({ path: 'tests/e2e/.auth/user.json' });
});
