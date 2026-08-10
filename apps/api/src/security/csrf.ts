import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { CSRF_COOKIE } from '../auth/session.js';

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
 * send the ev_csrf cookie value back in the x-csrf-token header.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const cookieValue = request.cookies?.[CSRF_COOKIE];
    const rawHeader = request.headers[CSRF_HEADER];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!csrfTokensMatch(cookieValue, headerValue)) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    return true;
  }
}
