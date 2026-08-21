import { describe, expect, it } from 'vitest';
import { createConnectorRequest } from '@aeg-clouddfir/contracts';
import {
  buildCreateConnector,
  buildGoogleOrgSetup,
  buildMicrosoftOrgSetup,
  defaultConnectorLabel,
} from './connector-setup';

const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('buildCreateConnector', () => {
  it('always includes a label — the API rejects a request without one', () => {
    // This is the whole bug. The page posted { provider, mode } and the API
    // required a label, so every Connect click 400d before Google was reached.
    const body = buildCreateConnector({
      provider: 'google',
      mode: 'delegated',
      label: '',
      now: NOW,
    });
    expect(body.label.length).toBeGreaterThan(0);
    expect(createConnectorRequest.safeParse(body).success).toBe(true);
  });

  it('keeps a label the operator typed, trimmed', () => {
    const body = buildCreateConnector({
      provider: 'google',
      mode: 'delegated',
      label: '  Litigation mailbox  ',
      now: NOW,
    });
    expect(body.label).toBe('Litigation mailbox');
  });

  it('names the provider, the mode and the date in the default label', () => {
    expect(defaultConnectorLabel('google', 'delegated', NOW)).toBe(
      'Google Workspace (personal) 2026-08-21',
    );
    expect(defaultConnectorLabel('microsoft', 'organization', NOW)).toBe(
      'Microsoft 365 (organization) 2026-08-21',
    );
  });

  it('produces a body the API schema accepts, for every provider and mode', () => {
    for (const provider of ['microsoft', 'google'] as const) {
      for (const mode of ['delegated', 'organization'] as const) {
        const body = buildCreateConnector({ provider, mode, label: '', now: NOW });
        expect(createConnectorRequest.safeParse(body).success).toBe(true);
      }
    }
  });
});

describe('buildMicrosoftOrgSetup', () => {
  it('sends externalTenantId, which is the name the API reads', () => {
    // The page used to send `entraTenantId`, inside a create call that ignored
    // the field entirely.
    expect(buildMicrosoftOrgSetup(' 0000-tenant ')).toEqual({ externalTenantId: '0000-tenant' });
  });

  it('refuses an empty tenant id rather than posting it', () => {
    expect(() => buildMicrosoftOrgSetup('   ')).toThrow();
  });
});

describe('buildGoogleOrgSetup', () => {
  it('splits allowed domains on new lines or commas', () => {
    const body = buildGoogleOrgSetup({
      serviceAccountJson: '{"type":"service_account"}',
      allowedDomains: 'example.com,\n  other.com \n',
      adminEmail: ' admin@example.com ',
    });
    expect(body.allowedDomains).toEqual(['example.com', 'other.com']);
    expect(body.adminEmail).toBe('admin@example.com');
  });

  it('refuses an empty domain list — it would authorize nothing', () => {
    expect(() =>
      buildGoogleOrgSetup({
        serviceAccountJson: '{"type":"service_account"}',
        allowedDomains: '  ',
        adminEmail: 'admin@example.com',
      }),
    ).toThrow();
  });

  it('refuses an address that is not an email', () => {
    expect(() =>
      buildGoogleOrgSetup({
        serviceAccountJson: '{"type":"service_account"}',
        allowedDomains: 'example.com',
        adminEmail: 'not-an-email',
      }),
    ).toThrow();
  });
});
