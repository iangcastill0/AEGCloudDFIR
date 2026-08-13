/**
 * Typed fetch wrapper for the AEG-CloudDFIR API (separate origin).
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
 * console lives here; AEG-CloudDFIR links out to it rather than embedding it
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

// --- Multipart uploads ---
//
// fetch() cannot report upload progress, so uploads go through
// XMLHttpRequest. The XHR is hidden behind UploadXhrLike so the wiring
// (progress mapping, response/error-envelope parsing) is unit testable with
// a stub; apiUpload adds the CSRF bootstrap and 401 handling of apiFetch.

/** The subset of a progress event the upload wiring needs. */
export interface UploadProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

/** Minimal structural XHR interface (method syntax so XMLHttpRequest fits). */
export interface UploadXhrLike {
  withCredentials: boolean;
  status: number;
  responseText: string;
  upload: {
    addEventListener(type: 'progress', listener: (event: UploadProgressEvent) => void): void;
  };
  addEventListener(type: 'load' | 'error', listener: () => void): void;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
}

/** Map a progress event to a 0..1 fraction; null when indeterminate. */
export function uploadProgressFraction(event: UploadProgressEvent): number | null {
  if (!event.lengthComputable || event.total <= 0) return null;
  return Math.min(1, Math.max(0, event.loaded / event.total));
}

/**
 * Interpret a completed upload response exactly like apiFetch would:
 * non-2xx bodies parse as the standard error envelope (→ ApiError),
 * 2xx bodies parse as JSON validated by the given schema.
 */
export function parseUploadResponse<T>(status: number, bodyText: string, schema: z.ZodType<T>): T {
  if (status < 200 || status >= 300) {
    throw new ApiError(parseErrorEnvelope(status, bodyText));
  }
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ApiError({
      statusCode: status,
      error: 'Bad Response',
      message: 'The upload completed but the server returned a non-JSON body.',
    });
  }
  return schema.parse(json);
}

export interface UploadRequest<T> {
  url: string;
  csrfToken: string;
  file: File;
  schema: z.ZodType<T>;
  onProgress?: (fraction: number) => void;
}

/** Drive an XHR-shaped transport through a multipart upload of one file. */
export function startUpload<T>(xhr: UploadXhrLike, request: UploadRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    xhr.open('POST', request.url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader(CSRF_HEADER_NAME, request.csrfToken);
    xhr.upload.addEventListener('progress', (event) => {
      const fraction = uploadProgressFraction(event);
      if (fraction !== null) request.onProgress?.(fraction);
    });
    xhr.addEventListener('load', () => {
      try {
        resolve(parseUploadResponse(xhr.status, xhr.responseText, request.schema));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    xhr.addEventListener('error', () => {
      reject(
        new ApiError({
          statusCode: 0,
          error: 'Network Error',
          message: 'The upload could not reach the server. Check your connection and retry.',
        }),
      );
    });
    const form = new FormData();
    form.append('file', request.file, request.file.name);
    xhr.send(form);
  });
}

export interface ApiUploadOptions<T> {
  schema: z.ZodType<T>;
  onProgress?: (fraction: number) => void;
}

/**
 * POST a single file as multipart/form-data (field name 'file') with the
 * same credential, CSRF, and error-envelope semantics as apiFetch.
 */
export async function apiUpload<T>(
  path: string,
  file: File,
  options: ApiUploadOptions<T>,
): Promise<T> {
  const csrfToken = await ensureCsrfToken();
  try {
    return await startUpload<T>(new XMLHttpRequest(), {
      url: `${API_URL}${path}`,
      csrfToken,
      file,
      schema: options.schema,
      onProgress: options.onProgress,
    });
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      redirectToLogin();
      throw new ApiError({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Your session has expired. Redirecting to sign-in…',
      });
    }
    throw err;
  }
}
