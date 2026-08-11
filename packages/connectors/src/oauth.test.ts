import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from './http.js';
import {
  GOOGLE_DWD_SCOPES,
  GoogleDelegatedTokenSource,
  GoogleServiceAccountTokenSource,
  MICROSOFT_DELEGATED_SCOPES,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  buildGoogleAuthorizationUrl,
  buildMicrosoftAdminConsentUrl,
  buildMicrosoftAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  exchangeMicrosoftAuthorizationCode,
} from './oauth.js';
import { DomainNotAllowedError, ProviderAuthError } from './types.js';

interface Call {
  url: string;
  body: URLSearchParams;
}

function tokenFetch(responses: (() => Response)[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
    const factory = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (factory === undefined) throw new Error('no queued response');
    return Promise.resolve(factory());
  };
  return { fetchImpl, calls };
}

const okToken =
  (extra: Record<string, unknown> = {}) =>
  () =>
    new Response(
      JSON.stringify({ access_token: 'at-1', expires_in: 3600, token_type: 'Bearer', ...extra }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

const PKCS8_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

describe('MicrosoftDelegatedTokenSource', () => {
  const build = (fetchImpl: FetchLike, rotated: string[], now?: () => number) =>
    new MicrosoftDelegatedTokenSource({
      msLoginBaseUrl: 'https://login.example',
      clientId: 'client-1',
      clientSecret: 'ms-secret-value',
      refreshToken: 'refresh-1',
      scopes: MICROSOFT_DELEGATED_SCOPES,
      onTokensRotated: (t) => {
        rotated.push(t);
        return Promise.resolve();
      },
      fetchImpl,
      now,
    });

  it('uses the refresh-token grant against the common tenant and fires rotation', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken({ refresh_token: 'refresh-2' })]);
    const rotated: string[] = [];
    const source = build(fetchImpl, rotated);
    expect(await source.getAccessToken()).toBe('at-1');
    expect(calls[0]?.url).toBe('https://login.example/common/oauth2/v2.0/token');
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.body.get('refresh_token')).toBe('refresh-1');
    expect(calls[0]?.body.get('scope')).toBe('offline_access User.Read Mail.Read Files.Read');
    expect(rotated).toEqual(['refresh-2']);
  });

  it('caches the access token until expiry minus skew', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken()]);
    const source = build(fetchImpl, []);
    await source.getAccessToken();
    await source.getAccessToken();
    expect(calls).toHaveLength(1);
  });

  it('refetches when the cached token is within the 60s skew window', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken({ expires_in: 30 }), okToken()]);
    const source = build(fetchImpl, []);
    await source.getAccessToken();
    await source.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it('invalidate() drops the cache', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken()]);
    const source = build(fetchImpl, []);
    await source.getAccessToken();
    source.invalidate();
    await source.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it('token failures never echo the client secret', async () => {
    const { fetchImpl } = tokenFetch([
      () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'ms-secret-value leaked?' }),
          { status: 400 },
        ),
    ]);
    const source = build(fetchImpl, []);
    const err = await source.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as ProviderAuthError).providerCode).toBe('invalid_grant');
    expect((err as ProviderAuthError).message).not.toContain('ms-secret-value');
    expect((err as ProviderAuthError).message).not.toContain('leaked');
  });
});

describe('MicrosoftAppTokenSource', () => {
  it('uses client-credentials with the .default scope against the tenant endpoint', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken()]);
    const source = new MicrosoftAppTokenSource({
      msLoginBaseUrl: 'https://login.example',
      tenantId: 'tenant-xyz',
      clientId: 'client-1',
      clientSecret: 's',
      fetchImpl,
    });
    await source.getAccessToken();
    expect(calls[0]?.url).toBe('https://login.example/tenant-xyz/oauth2/v2.0/token');
    expect(calls[0]?.body.get('grant_type')).toBe('client_credentials');
    expect(calls[0]?.body.get('scope')).toBe('https://graph.microsoft.com/.default');
  });
});

describe('GoogleDelegatedTokenSource', () => {
  it('uses the refresh-token grant against the configured token URL', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken()]);
    const source = new GoogleDelegatedTokenSource({
      googleOauthTokenUrl: 'https://oauth.example/token',
      clientId: 'gc',
      clientSecret: 'gs',
      refreshToken: 'gr-1',
      fetchImpl,
    });
    await source.getAccessToken();
    expect(calls[0]?.url).toBe('https://oauth.example/token');
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.body.get('refresh_token')).toBe('gr-1');
  });
});

describe('GoogleServiceAccountTokenSource', () => {
  const options = (impersonateEmail: string, fetchImpl: FetchLike) => ({
    googleOauthTokenUrl: 'https://oauth.example/token',
    serviceAccountJson: { client_email: 'svc@proj.iam.example.com', private_key: PKCS8_PEM },
    scopes: GOOGLE_DWD_SCOPES,
    impersonateEmail,
    allowedDomains: ['Example.com'],
    fetchImpl,
  });

  it('throws DomainNotAllowedError for a foreign domain', () => {
    const { fetchImpl } = tokenFetch([okToken()]);
    expect(() => new GoogleServiceAccountTokenSource(options('a@other.com', fetchImpl))).toThrow(
      DomainNotAllowedError,
    );
  });

  it('accepts allowed domains case-insensitively and builds a correct JWT assertion', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken()]);
    const source = new GoogleServiceAccountTokenSource(
      options('avery.chen@EXAMPLE.com', fetchImpl),
    );
    await source.getAccessToken();
    expect(calls[0]?.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = calls[0]?.body.get('assertion') ?? '';
    const claims = decodeJwt(assertion);
    expect(claims.iss).toBe('svc@proj.iam.example.com');
    expect(claims.sub).toBe('avery.chen@EXAMPLE.com');
    expect(claims.aud).toBe('https://oauth.example/token');
    expect(claims['scope']).toBe(GOOGLE_DWD_SCOPES.join(' '));
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);
  });
});

describe('authorization URL builders', () => {
  it('builds the Microsoft delegated URL with PKCE', () => {
    const url = new URL(
      buildMicrosoftAuthorizationUrl({
        msLoginBaseUrl: 'https://login.example',
        clientId: 'client-1',
        redirectUri: 'https://ev.example/cb',
        scopes: MICROSOFT_DELEGATED_SCOPES,
        state: 'state-1',
        codeChallenge: 'challenge-abc',
      }),
    );
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Mail.Read Files.Read');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('builds the Google URL with offline access and forced consent', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: 'gc',
        redirectUri: 'https://ev.example/cb',
        scopes: ['openid', 'email'],
        state: 's',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('builds the Entra admin-consent URL', () => {
    const url = new URL(
      buildMicrosoftAdminConsentUrl({
        msLoginBaseUrl: 'https://login.example',
        tenantId: 'tenant-123',
        clientId: 'client-1',
        redirectUri: 'https://ev.example/admin-cb',
        state: 'st',
      }),
    );
    expect(url.pathname).toBe('/tenant-123/adminconsent');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ev.example/admin-cb');
    expect(url.searchParams.get('state')).toBe('st');
  });
});

describe('authorization code exchange', () => {
  it('Microsoft exchange sends the code verifier', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken({ refresh_token: 'r-new' })]);
    const tokens = await exchangeMicrosoftAuthorizationCode({
      msLoginBaseUrl: 'https://login.example',
      clientId: 'client-1',
      clientSecret: 's',
      code: 'auth-code',
      redirectUri: 'https://ev.example/cb',
      codeVerifier: 'verifier-xyz',
      scopes: MICROSOFT_DELEGATED_SCOPES,
      fetchImpl,
    });
    expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
    expect(calls[0]?.body.get('code_verifier')).toBe('verifier-xyz');
    expect(tokens.refreshToken).toBe('r-new');
  });

  it('Google exchange posts to the configured token URL', async () => {
    const { fetchImpl, calls } = tokenFetch([okToken({ refresh_token: 'gr-new' })]);
    const tokens = await exchangeGoogleAuthorizationCode({
      googleOauthTokenUrl: 'https://oauth.example/token',
      clientId: 'gc',
      clientSecret: 'gs',
      code: 'auth-code',
      redirectUri: 'https://ev.example/cb',
      fetchImpl,
    });
    expect(calls[0]?.url).toBe('https://oauth.example/token');
    expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
    expect(tokens.refreshToken).toBe('gr-new');
  });
});
