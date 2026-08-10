import { randomUUID } from 'node:crypto';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Use the inbound x-request-id header when it is a sane opaque token,
 * otherwise mint a fresh UUID. Never trusts arbitrary header content.
 */
export function resolveRequestId(header: unknown): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === 'string' && REQUEST_ID_RE.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}
