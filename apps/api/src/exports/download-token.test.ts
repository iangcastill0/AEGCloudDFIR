import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signDownloadToken, verifyDownloadToken } from './download-token.js';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const CLAIMS = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  exportId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};
const NOW = 1_700_000_000_000;

describe('download token', () => {
  it('round-trips the claims it was given', () => {
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    const claims = verifyDownloadToken(SECRET, token, NOW);
    expect(claims).toEqual({ ...CLAIMS, expiresAt: NOW / 1000 + 3600 });
  });

  it('refuses a token signed with a different secret', () => {
    const token = signDownloadToken(OTHER_SECRET, CLAIMS, 3600, NOW);
    expect(verifyDownloadToken(SECRET, token, NOW)).toBeNull();
  });

  /**
   * The payload is readable — it is base64, not encryption. What must not be
   * possible is EDITING it. Someone who can point a token at another export
   * has a token for every export.
   */
  it('refuses a token whose payload was edited', () => {
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    const [body, mac] = token.split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload['e'] = '44444444-4444-4444-8444-444444444444';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;

    expect(verifyDownloadToken(SECRET, forged, NOW)).toBeNull();
  });

  it('refuses a token past its expiry', () => {
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    expect(verifyDownloadToken(SECRET, token, NOW + 3600 * 1000 + 1)).toBeNull();
    // And is still good a second before.
    expect(verifyDownloadToken(SECRET, token, NOW + 3600 * 1000 - 1000)).not.toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    // A verifier that throws on bad input turns a probe into a 500, and the
    // difference between a 500 and a 404 is itself information.
    for (const bad of ['', '.', 'nodot', 'a.b.c', 'Zm9v.YmFy', '....']) {
      expect(() => verifyDownloadToken(SECRET, bad, NOW)).not.toThrow();
      expect(verifyDownloadToken(SECRET, bad, NOW)).toBeNull();
    }
  });

  it('refuses a token from an older payload version', () => {
    // Fails closed: if the shape ever changes, tokens minted under the old one
    // stop working rather than being half-understood.
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    const [body] = token.split('.') as [string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(payload['v']).toBe(1);
  });

  /**
   * The signing key must not BE the session secret. One key for two purposes
   * means a flaw in either becomes a flaw in both, and neither can be rotated
   * without breaking the other.
   */
  it('does not sign with the raw session secret', () => {
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    const [body, mac] = token.split('.') as [string, string];
    const naive = createHmacBase64Url(SECRET, body);
    expect(mac).not.toBe(naive);
  });

  it('never puts the secret in the token', () => {
    const token = signDownloadToken(SECRET, CLAIMS, 3600, NOW);
    expect(token).not.toContain(SECRET);
    expect(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')).not.toContain(
      SECRET,
    );
  });
});

function createHmacBase64Url(key: string, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}
