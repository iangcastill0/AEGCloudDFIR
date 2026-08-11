/**
 * CSRF double-submit plumbing. Pure functions so header-injection logic is
 * unit testable without a browser.
 */
export const CSRF_COOKIE_NAME = 'ev_csrf';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** Read a cookie value from a document.cookie-style string. */
export function readCookieValue(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** True when this HTTP method must carry the CSRF header. */
export function methodNeedsCsrf(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/**
 * Build the headers for an API request given the cookie jar string.
 * Returns null for the token when a bootstrap fetch of /auth/csrf is needed.
 */
export function csrfHeaderFromCookies(cookieString: string): { [CSRF_HEADER_NAME]: string } | null {
  const token = readCookieValue(cookieString, CSRF_COOKIE_NAME);
  if (!token) return null;
  return { [CSRF_HEADER_NAME]: token };
}
