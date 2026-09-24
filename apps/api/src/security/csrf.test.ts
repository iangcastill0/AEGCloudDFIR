import { describe, expect, it } from 'vitest';
import { ForbiddenException, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ExportDownloadRefreshController,
  ExportsController,
} from '../exports/exports.controller.js';
import { CsrfGuard, csrfTokensMatch, generateCsrfToken } from './csrf.js';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator.js';

interface FakeRequest {
  method: string;
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

/** A handler with no metadata on it, standing in for an ordinary route. */
function plainHandler(): void {
  /* no metadata */
}

function contextFor(
  request: FakeRequest,
  handler: unknown = plainHandler,
  controller: unknown = class Anything {},
): ExecutionContext {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
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
  const guard = new CsrfGuard(new Reflector());
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

  /**
   * The base case the exemption must never erode: an ordinary mutating route,
   * no cookie and no header, still refused. If this ever passes, the guard has
   * stopped guarding and every other test here is decoration.
   */
  it('still rejects a mutating request carrying no token at all on a normal route', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const ctx = contextFor({ method, cookies: {}, headers: {} });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    }
  });

  it('a Bearer header alone does not get a normal route past the check', () => {
    // Bearer is what makes the ONE exempt route safe. It must not become a
    // way round the check anywhere else.
    const ctx = contextFor({
      method: 'POST',
      cookies: {},
      headers: { authorization: 'Bearer some-token' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

/**
 * Run against the REAL decorated handlers, not a stand-in class.
 *
 * A synthetic `@SkipCsrf()` class in here would prove the guard reads metadata.
 * It would not prove the decorator is actually on the download-refresh route,
 * which is the thing that was broken. These use the shipped controllers, so the
 * test fails if the decorator is ever removed from the route.
 */
describe('CsrfGuard and @SkipCsrf, on the real routes', () => {
  const guard = new CsrfGuard(new Reflector());

  it('lets the download-URL refresh through with a Bearer token and no cookie', () => {
    const ctx = contextFor(
      { method: 'POST', cookies: {}, headers: { authorization: 'Bearer t' } },
      ExportDownloadRefreshController.prototype.refresh,
      ExportDownloadRefreshController,
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('is still refused without a token on the neighbouring export routes', () => {
    // Same path prefix, same module, no exemption. POST /api/v1/exports must
    // not inherit anything from the refresh route.
    const ctx = contextFor(
      { method: 'POST', cookies: {}, headers: {} },
      ExportsController.prototype.create,
      ExportsController,
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  /**
   * TypeScript already refuses `@SkipCsrf()` on a class, because the decorator
   * is typed `MethodDecorator`. This proves the runtime agrees, so bypassing
   * the types — a cast, a `.js` caller, a future refactor — still cannot exempt
   * a whole controller in one line.
   */
  it('ignores the mark when it is on the controller class instead of a handler', () => {
    class SneakyController {
      mutate(): void {
        /* not marked */
      }
    }
    SetMetadata(SKIP_CSRF_KEY, true)(SneakyController);
    expect(Reflect.getMetadata(SKIP_CSRF_KEY, SneakyController)).toBe(true);

    const ctx = contextFor(
      { method: 'POST', cookies: {}, headers: {} },
      SneakyController.prototype.mutate,
      SneakyController,
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('fails closed when there is no handler to read', () => {
    const ctx = contextFor({ method: 'POST', cookies: {}, headers: {} }, undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
