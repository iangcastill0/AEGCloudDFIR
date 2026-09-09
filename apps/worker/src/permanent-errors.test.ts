import { describe, expect, it } from 'vitest';
import { ProviderApiError, ProviderAuthError, SlackApiError } from '@aeg-clouddfir/connectors';
import { classifyProviderError, isPermanentProviderError } from './permanent-errors.js';

const auth = (providerCode?: string) =>
  new ProviderAuthError('token endpoint returned HTTP 400', {
    status: 400,
    ...(providerCode === undefined ? {} : { providerCode }),
  });

const api = (status: number, providerCode?: string) =>
  new ProviderApiError(`call returned HTTP ${String(status)}`, {
    status,
    ...(providerCode === undefined ? {} : { providerCode }),
  });

describe('classifyProviderError', () => {
  it('stops retrying when the customer has disabled our application', () => {
    // AADSTS7000112. The real one: 6,720 identical token requests in five
    // minutes, every one waiting on a person in another company's admin portal.
    const verdict = classifyProviderError(auth('unauthorized_client'));
    expect(verdict.permanent).toBe(true);
    expect(verdict.reason).toContain('unauthorized_client');
  });

  it('stops retrying a bad or expired client secret', () => {
    expect(isPermanentProviderError(auth('invalid_client'))).toBe(true);
  });

  it('stops retrying a revoked grant', () => {
    // Only a fresh sign-in produces a new refresh token.
    expect(isPermanentProviderError(auth('invalid_grant'))).toBe(true);
  });

  it('stops retrying a permission the app was never granted', () => {
    expect(isPermanentProviderError(api(403, 'Authorization_RequestDenied'))).toBe(true);
  });

  it('stops retrying a custodian who has no OneDrive', () => {
    // "User's mysite not found" — retried eight times per custodian for
    // something that does not exist and is not about to.
    expect(isPermanentProviderError(api(404, 'ResourceNotFound'))).toBe(true);
  });

  it('stops retrying a malformed query, which is byte-identical every time', () => {
    expect(isPermanentProviderError(api(400, 'BadRequest'))).toBe(true);
  });

  it('keeps retrying rate limiting', () => {
    // This is what retries are for.
    expect(isPermanentProviderError(api(429))).toBe(false);
  });

  it('keeps retrying rate limiting even when it carries a terminal-looking code', () => {
    // Status wins over the code: a 429 is a moment, whatever came with it.
    expect(isPermanentProviderError(api(429, 'BadRequest'))).toBe(false);
  });

  it('keeps retrying a provider outage', () => {
    expect(isPermanentProviderError(api(503))).toBe(false);
    expect(isPermanentProviderError(api(500, 'ResourceNotFound'))).toBe(false);
  });

  it('keeps retrying an auth failure with no code — it may be transient', () => {
    expect(isPermanentProviderError(auth())).toBe(false);
  });

  it('keeps retrying an unrecognised provider code', () => {
    // The most important rule here. Writing off a code this version has never
    // seen turns an unknown into a permanent hole in the evidence, and a gap
    // nobody was told about is worse than a slow retry.
    expect(isPermanentProviderError(api(400, 'SomethingBrandNew'))).toBe(false);
  });

  it('keeps retrying anything that is not a provider error at all', () => {
    expect(isPermanentProviderError(new TypeError('x is not a function'))).toBe(false);
    expect(isPermanentProviderError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentProviderError(undefined)).toBe(false);
  });

  it('still honours the Slack rules', () => {
    const slack = (code: string) => new SlackApiError(`slack: ${code}`, { slackError: code });
    expect(isPermanentProviderError(slack('channel_not_found'))).toBe(true);
    expect(isPermanentProviderError(slack('ratelimited'))).toBe(false);
  });

  it('treats a 403 that survived a token refresh as a decision, not a moment', () => {
    expect(isPermanentProviderError(api(403))).toBe(true);
  });

  it('gives an empty reason when it is not permanent', () => {
    expect(classifyProviderError(api(429))).toEqual({ permanent: false, reason: '' });
  });
});
