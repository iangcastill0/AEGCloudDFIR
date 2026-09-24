import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { CSRF_COOKIE } from '../auth/session.js';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator.js';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 32 random bytes as hex; stored in a JS-readable cookie for double submit. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison; false for missing values or length mismatch. */
export function csrfTokensMatch(cookieValue: unknown, headerValue: unknown): boolean {
  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') return false;
  if (cookieValue.length === 0 || headerValue.length === 0) return false;
  const a = Buffer.from(cookieValue, 'utf8');
  const b = Buffer.from(headerValue, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Double-submit CSRF guard. Registered globally: every mutating request must
 * send the cdfir_csrf cookie value back in the x-csrf-token header.
 *
 * One handler is exempt, marked with `@SkipCsrf()` — see that decorator for why
 * a Bearer-only route cannot be attacked this way.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    if (this.isExempt(context)) return true;

    const cookieValue = request.cookies?.[CSRF_COOKIE];
    const rawHeader = request.headers[CSRF_HEADER];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!csrfTokensMatch(cookieValue, headerValue)) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }

  /**
   * The handler, and ONLY the handler. `getAllAndOverride` would also read the
   * controller class, and one `@SkipCsrf()` up there would silently exempt
   * every route on it — including the ones somebody adds next year. Anything
   * that is not a route handler carrying the mark fails closed.
   */
  private isExempt(context: ExecutionContext): boolean {
    const handler: unknown = context.getHandler();
    if (typeof handler !== 'function') return false;
    return this.reflector.get<boolean>(SKIP_CSRF_KEY, handler) === true;
  }
}
