import { describe, expect, it } from 'vitest';
import {
  createSessionPayload,
  deriveSealingKey,
  openAuthFlow,
  openSession,
  sealAuthFlow,
  sealSession,
  sessionCookieName,
  type AuthFlowPayload,
} from './session.js';

const SECRET = 'unit-test-session-secret-at-least-32-chars-long';
const KEY = deriveSealingKey(SECRET);
const USER_ID = '11111111-2222-4333-8444-555555555555';
const TENANT_ID = '99999999-8888-4777-8666-555555555555';

function tamper(sealed: string, byteIndex: number): string {
  const buf = Buffer.from(sealed, 'base64url');
  const i = byteIndex % buf.length;
  buf[i] = (buf[i] ?? 0) ^ 0xff;
  return buf.toString('base64url');
}

describe('deriveSealingKey', () => {
  it('is a deterministic 32-byte key', () => {
    expect(deriveSealingKey(SECRET)).toHaveLength(32);
    expect(deriveSealingKey(SECRET).equals(KEY)).toBe(true);
    expect(deriveSealingKey('another-secret-that-is-long-enough-000').equals(KEY)).toBe(false);
  });
});

describe('sealSession / openSession', () => {
  it('round-trips a session without tenantId', () => {
    const payload = createSessionPayload(USER_ID, undefined, 3600);
    const opened = openSession(KEY, sealSession(KEY, payload));
    expect(opened).toEqual(payload);
    expect(opened?.tenantId).toBeUndefined();
  });

  it('round-trips a session with tenantId', () => {
    const payload = createSessionPayload(USER_ID, TENANT_ID, 3600);
    expect(openSession(KEY, sealSession(KEY, payload))).toEqual(payload);
  });

  it('produces distinct ciphertexts per seal (fresh iv)', () => {
    const payload = createSessionPayload(USER_ID, undefined, 3600);
    expect(sealSession(KEY, payload)).not.toEqual(sealSession(KEY, payload));
  });

  it('rejects tampered cookies anywhere in the buffer', () => {
    const sealed = sealSession(KEY, createSessionPayload(USER_ID, undefined, 3600));
    for (const index of [0, 5, 13, 20, 40, sealed.length - 2]) {
      expect(openSession(KEY, tamper(sealed, index))).toBeNull();
    }
  });

  it('rejects a cookie sealed with a different key', () => {
    const other = deriveSealingKey('a-completely-different-32+char-secret-value');
    const sealed = sealSession(other, createSessionPayload(USER_ID, undefined, 3600));
    expect(openSession(KEY, sealed)).toBeNull();
  });

  it('rejects expired sessions', () => {
    const payload = createSessionPayload(USER_ID, undefined, 60);
    const sealed = sealSession(KEY, payload);
    expect(openSession(KEY, sealed, (payload.exp + 1) * 1000)).toBeNull();
    // exactly at expiry is also rejected
    expect(openSession(KEY, sealed, payload.exp * 1000)).toBeNull();
    // just before expiry is fine
    expect(openSession(KEY, sealed, payload.exp * 1000 - 1)).not.toBeNull();
  });

  it('rejects garbage, empty, and truncated inputs', () => {
    expect(openSession(KEY, '')).toBeNull();
    expect(openSession(KEY, 'not-a-cookie')).toBeNull();
    expect(openSession(KEY, Buffer.from('short').toString('base64url'))).toBeNull();
  });

  it('rejects structurally invalid payloads sealed with the right key', () => {
    // Valid encryption but wrong shape: an authflow payload is not a session.
    const flow: AuthFlowPayload = {
      v: 1,
      kind: 'authflow',
      state: 's',
      nonce: 'n',
      verifier: 'v',
      redirectTo: '/',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    expect(openSession(KEY, sealAuthFlow(KEY, flow))).toBeNull();
  });
});

describe('sealAuthFlow / openAuthFlow', () => {
  const now = Math.floor(Date.now() / 1000);
  const flow: AuthFlowPayload = {
    v: 1,
    kind: 'authflow',
    state: 'state-value',
    nonce: 'nonce-value',
    verifier: 'verifier-value',
    redirectTo: '/cases',
    iat: now,
    exp: now + 600,
  };

  it('round-trips', () => {
    expect(openAuthFlow(KEY, sealAuthFlow(KEY, flow))).toEqual(flow);
  });

  it('rejects tampering and expiry', () => {
    const sealed = sealAuthFlow(KEY, flow);
    expect(openAuthFlow(KEY, tamper(sealed, 30))).toBeNull();
    expect(openAuthFlow(KEY, sealed, (flow.exp + 1) * 1000)).toBeNull();
  });

  it('rejects a session payload where an authflow is expected', () => {
    const sealed = sealSession(KEY, createSessionPayload(USER_ID, undefined, 3600));
    expect(openAuthFlow(KEY, sealed)).toBeNull();
  });
});

describe('sessionCookieName', () => {
  it('uses the __Host- prefix only in production (requires Secure)', () => {
    expect(sessionCookieName(true)).toBe('__Host-ev_session');
    expect(sessionCookieName(false)).toBe('ev_session');
  });
});
