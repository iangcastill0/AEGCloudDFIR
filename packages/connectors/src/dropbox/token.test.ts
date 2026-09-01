import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../http.js';
import { DropboxDelegatedTokenSource, exchangeDropboxAuthorizationCode } from '../oauth.js';
import { ProviderAuthError } from '../types.js';

interface Call {
  url: string;
  body: URLSearchParams;
}

function recording(status = 200, payload: unknown = { access_token: 'at', expires_in: 14_400 }) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

describe('exchangeDropboxAuthorizationCode', () => {
  it('sends the PKCE verifier, or Dropbox rejects the exchange', () => {
    const { fetchImpl, calls } = recording();
    return exchangeDropboxAuthorizationCode({
      clientId: 'key',
      clientSecret: 'secret',
      code: 'the-code',
      redirectUri: 'https://api.test/cb',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://token.test/oauth2/token',
      fetchImpl,
    }).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://token.test/oauth2/token');
      expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
      expect(calls[0]?.body.get('code_verifier')).toBe('verifier');
      expect(calls[0]?.body.get('redirect_uri')).toBe('https://api.test/cb');
    });
  });

  it('raises a provider auth error rather than returning a broken token', async () => {
    const { fetchImpl } = recording(400, { error: 'invalid_grant' });
    await expect(
      exchangeDropboxAuthorizationCode({
        clientId: 'key',
        clientSecret: 'secret',
        code: 'stale',
        redirectUri: 'https://api.test/cb',
        codeVerifier: 'v',
        tokenEndpoint: 'https://token.test/oauth2/token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

describe('DropboxDelegatedTokenSource', () => {
  it('uses the refresh grant', async () => {
    const { fetchImpl, calls } = recording();
    const source = new DropboxDelegatedTokenSource({
      clientId: 'key',
      clientSecret: 'secret',
      refreshToken: 'rt',
      tokenEndpoint: 'https://token.test/oauth2/token',
      fetchImpl,
    });
    expect(await source.getAccessToken()).toBe('at');
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
    expect(calls[0]?.body.get('refresh_token')).toBe('rt');
  });

  it('caches, so a long collection does not re-authenticate per request', async () => {
    // Dropbox access tokens last about four hours. Fetching one per API call
    // would multiply every collection's request count by two and invite
    // rate-limiting on the token endpoint.
    const { fetchImpl, calls } = recording();
    const source = new DropboxDelegatedTokenSource({
      clientId: 'key',
      clientSecret: 'secret',
      refreshToken: 'rt',
      tokenEndpoint: 'https://token.test/oauth2/token',
      fetchImpl,
    });
    await source.getAccessToken();
    await source.getAccessToken();
    await source.getAccessToken();
    expect(calls).toHaveLength(1);
  });
});
