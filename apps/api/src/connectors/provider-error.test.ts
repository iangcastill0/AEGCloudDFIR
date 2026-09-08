import { describe, expect, it } from 'vitest';
import { ConnectorError, ProviderApiError } from '@aeg-clouddfir/connectors';
import { ConnectorCredentialsError } from './token-provider.factory.js';
import { providerHttpError, withProviderErrors } from './provider-error.js';

const apiError = (status: number, providerCode?: string) =>
  new ProviderApiError(`listUsers: provider returned HTTP ${String(status)}`, {
    status,
    ...(providerCode === undefined ? {} : { providerCode }),
  });

describe('providerHttpError', () => {
  it('turns a provider 403 into a 409 that names what a human must do', () => {
    // The real case: Entra had never been granted User.Read.All, Graph answered
    // 403 Authorization_RequestDenied, and the custodian list returned a bare
    // 500 with no body. The operator saw an empty page and no reason for it.
    const mapped = providerHttpError(
      apiError(403, 'Authorization_RequestDenied'),
      'Custodian lookup',
    );
    expect(mapped?.getStatus()).toBe(409);
    const message = JSON.stringify(mapped?.getResponse());
    expect(message).toContain('Custodian lookup');
    expect(message).toContain('Authorization_RequestDenied');
    expect(message).toContain('grant consent');
  });

  it('treats a provider 401 the same way — asking again will not help', () => {
    expect(providerHttpError(apiError(401), 'Custodian lookup')?.getStatus()).toBe(409);
  });

  it('keeps permission failures below 500 so the browser stops retrying', () => {
    // apps/web/src/components/Providers.tsx retries anything >= 500 twice. As a
    // 500 this produced six identical requests in ten seconds against a
    // permission error that could never succeed.
    const status = providerHttpError(apiError(403), 'Custodian lookup')?.getStatus() ?? 0;
    expect(status).toBeLessThan(500);
  });

  it('reports rate limiting as retryable', () => {
    expect(providerHttpError(apiError(429), 'Custodian lookup')?.getStatus()).toBe(503);
  });

  it('reports a provider outage as a bad gateway, not our fault and worth retrying', () => {
    expect(providerHttpError(apiError(503), 'Custodian lookup')?.getStatus()).toBe(502);
  });

  it('asks for a reconnect when the stored credential cannot be used', () => {
    const mapped = providerHttpError(
      new ConnectorCredentialsError('no secret'),
      'Custodian lookup',
    );
    expect(mapped?.getStatus()).toBe(409);
    expect(JSON.stringify(mapped?.getResponse())).toContain('Reconnect');
  });

  it('maps any other connector error to a bad gateway', () => {
    expect(
      providerHttpError(new ConnectorError('socket closed'), 'Custodian lookup')?.getStatus(),
    ).toBe(502);
  });

  it('returns null for our own bugs so they still surface as a logged 500', () => {
    // A TypeError here is a defect in this codebase. Dressing it up as a
    // provider fault would hide it and blame the provider.
    expect(providerHttpError(new TypeError('x is not a function'), 'Custodian lookup')).toBeNull();
  });
});

describe('withProviderErrors', () => {
  it('passes the value through when nothing fails', async () => {
    await expect(withProviderErrors('Custodian lookup', async () => 42)).resolves.toBe(42);
  });

  it('rethrows a non-provider error unchanged', async () => {
    const boom = new TypeError('x is not a function');
    await expect(withProviderErrors('Custodian lookup', () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
  });

  it('converts a provider error', async () => {
    await expect(
      withProviderErrors('Custodian lookup', () => Promise.reject(apiError(403))),
    ).rejects.toMatchObject({ status: 409 });
  });
});
