/**
 * Typed fetch wrapper for the EvidenceVault API (separate origin).
 * - credentials: 'include' on every call
 * - double-submit CSRF header on mutating methods (bootstraps /auth/csrf)
 * - error-envelope parsing into ApiError
 * - 401 → redirect to {API}/auth/login?redirectTo={current}
 * - optional zod schema parsing of responses
 */
import type { z } from 'zod';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, methodNeedsCsrf, readCookieValue } from './csrf';
import { ApiError, parseErrorEnvelope } from './errors';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

/**
 * Base URL of the Authentik instance (the identity provider). Its own admin
 * console lives here; EvidenceVault links out to it rather than embedding it
 * (Authentik denies iframing by default).
 */
export const AUTHENTIK_URL = (
  process.env.NEXT_PUBLIC_AUTHENTIK_URL ?? 'http://localhost:9443'
).replace(/\/$/, '');

let csrfBootstrap: Promise<string> | null = null;

async function ensureCsrfToken(): Promise<string> {
  const existing = readCookieValue(document.cookie, CSRF_COOKIE_NAME);
  if (existing) return existing;
  csrfBootstrap ??= fetch(`${API_URL}/auth/csrf`, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(parseErrorEnvelope(res.status, await res.text()));
      const body = (await res.json()) as { token?: unknown };
      return typeof body.token === 'string'
        ? body.token
        : (readCookieValue(document.cookie, CSRF_COOKIE_NAME) ?? '');
    })
    .finally(() => {
      csrfBootstrap = null;
    });
  return csrfBootstrap;
}

export function loginUrl(): string {
  const current =
    typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
  return `${API_URL}/auth/login?redirectTo=${encodeURIComponent(current)}`;
}

function redirectToLogin(): void {
  if (typeof window !== 'undefined') {
    window.location.assign(loginUrl());
  }
}

export interface ApiFetchOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions<T> = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (methodNeedsCsrf(method)) {
    headers[CSRF_HEADER_NAME] = await ensureCsrfToken();
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new ApiError({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Your session has expired. Redirecting to sign-in…',
    });
  }

  if (!response.ok) {
    throw new ApiError(parseErrorEnvelope(response.status, await response.text()));
  }

  if (response.status === 204) return undefined as T;

  const json: unknown = await response.json();
  if (options.schema) return options.schema.parse(json);
  return json as T;
}

/** Absolute URL for API-served downloads (manifests, export archives…). */
export function apiDownloadUrl(path: string): string {
  return `${API_URL}${path}`;
}
