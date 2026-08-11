import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Sealed (encrypted + authenticated) cookie payloads using AES-256-GCM.
 * Wire format: base64url( iv[12] | authTag[16] | ciphertext ).
 * The key is SHA-256(EV_SESSION_SECRET); GCM's auth tag rejects any tampering.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Cookie names. __Host- prefix requires Secure, so non-prod uses a plain name. */
export const SESSION_COOKIE_PROD = '__Host-ev_session';
export const SESSION_COOKIE_DEV = 'ev_session';
export const AUTH_FLOW_COOKIE = 'ev_authflow';
export const CSRF_COOKIE = 'ev_csrf';
export const CONNECTOR_FLOW_COOKIE = 'ev_connectorflow';

export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

const sessionSchema = z.object({
  v: z.literal(1),
  userId: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type SessionPayload = z.infer<typeof sessionSchema>;

const authFlowSchema = z.object({
  v: z.literal(1),
  kind: z.literal('authflow'),
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(1),
  redirectTo: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AuthFlowPayload = z.infer<typeof authFlowSchema>;

/**
 * Provider-OAuth connect flow, sealed into the `state` parameter AND a
 * short-TTL cookie: the callback requires both to match, binding the flow to
 * the browser that started it. Carries the PKCE verifier for Microsoft.
 */
const connectorFlowSchema = z.object({
  v: z.literal(1),
  kind: z.literal('connectorflow'),
  connectorId: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  provider: z.enum(['microsoft', 'google']),
  verifier: z.string().default(''),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type ConnectorFlowPayload = z.infer<typeof connectorFlowSchema>;

/** Derive the 32-byte AES key from the configured session secret. */
export function deriveSealingKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function seal(key: Buffer, payload: unknown): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function open(key: Buffer, sealed: string): unknown {
  try {
    const buf = Buffer.from(sealed, 'base64url');
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return null;
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Build a fresh session payload with iat/exp in epoch seconds. */
export function createSessionPayload(
  userId: string,
  tenantId: string | undefined,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): SessionPayload {
  const iat = Math.floor(nowMs / 1000);
  return {
    v: 1,
    userId,
    ...(tenantId !== undefined ? { tenantId } : {}),
    iat,
    exp: iat + ttlSeconds,
  };
}

export function sealSession(key: Buffer, payload: SessionPayload): string {
  return seal(key, payload);
}

/** Returns null on tamper, malformed content, wrong key, or expiry. */
export function openSession(
  key: Buffer,
  sealed: string,
  nowMs: number = Date.now(),
): SessionPayload | null {
  const parsed = sessionSchema.safeParse(open(key, sealed));
  if (!parsed.success) return null;
  if (parsed.data.exp * 1000 <= nowMs) return null;
  return parsed.data;
}

export function sealAuthFlow(key: Buffer, payload: AuthFlowPayload): string {
  return seal(key, payload);
}

export function sealConnectorFlow(key: Buffer, payload: ConnectorFlowPayload): string {
  return seal(key, payload);
}

/** Returns null on tamper, malformed content, wrong key, or expiry. */
export function openConnectorFlow(
  key: Buffer,
  sealed: string,
  nowMs: number = Date.now(),
): ConnectorFlowPayload | null {
  const parsed = connectorFlowSchema.safeParse(open(key, sealed));
  if (!parsed.success) return null;
  if (parsed.data.exp * 1000 <= nowMs) return null;
  return parsed.data;
}

/** Returns null on tamper, malformed content, wrong key, or expiry. */
export function openAuthFlow(
  key: Buffer,
  sealed: string,
  nowMs: number = Date.now(),
): AuthFlowPayload | null {
  const parsed = authFlowSchema.safeParse(open(key, sealed));
  if (!parsed.success) return null;
  if (parsed.data.exp * 1000 <= nowMs) return null;
  return parsed.data;
}
