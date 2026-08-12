import { describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CsrfGuard, csrfTokensMatch, generateCsrfToken } from './csrf.js';

interface FakeRequest {
  method: string;
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

function contextFor(request: FakeRequest): ExecutionContext {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return ctx as unknown as ExecutionContext;
}

describe('generateCsrfToken', () => {
  it('produces 64 hex chars of fresh randomness', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toEqual(b);
  });
});

describe('csrfTokensMatch', () => {
  it('matches identical tokens', () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
  });

  it('rejects mismatched tokens of equal length', () => {
    expect(csrfTokensMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('rejects different lengths without throwing (timingSafeEqual precondition)', () => {
    expect(csrfTokensMatch('abc', 'abcd')).toBe(false);
  });

  it('rejects missing or non-string values', () => {
    expect(csrfTokensMatch(undefined, 'x')).toBe(false);
    expect(csrfTokensMatch('x', undefined)).toBe(false);
    expect(csrfTokensMatch(undefined, undefined)).toBe(false);
    expect(csrfTokensMatch('', '')).toBe(false);
    expect(csrfTokensMatch(42, 42)).toBe(false);
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();
  const token = generateCsrfToken();

  it('lets safe methods through without any token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(contextFor({ method, cookies: {}, headers: {} }))).toBe(true);
    }
  });

  it('passes a mutating request when cookie and header match', () => {
    const ctx = contextFor({
      method: 'POST',
      cookies: { cdfir_csrf: token },
      headers: { 'x-csrf-token': token },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    const ctx = contextFor({ method: 'POST', cookies: { cdfir_csrf: token }, headers: {} });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects when the cookie is missing', () => {
    const ctx = contextFor({ method: 'POST', cookies: {}, headers: { 'x-csrf-token': token } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects on mismatch, for every mutating method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const ctx = contextFor({
        method,
        cookies: { cdfir_csrf: token },
        headers: { 'x-csrf-token': generateCsrfToken() },
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    }
  });
});
