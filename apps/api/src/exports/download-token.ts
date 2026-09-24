import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A credential that lets a download script fetch fresh presigned URLs for ONE
 * export, and nothing else.
 *
 * Why this exists: presigned URLs live 300 seconds. A 130 GiB export is 65
 * parts, which cannot all be started inside five minutes at any realistic
 * speed, so a long download has to re-sign as it goes. A browser can just call
 * the endpoint again with its session cookie. A shell script cannot, and
 * pasting a session cookie into a file on disk would hand out the operator's
 * whole account to anyone who read it.
 *
 * So the script carries this instead: one export, read-only, time-boxed.
 *
 * Stateless on purpose. A table would allow revocation, and that is a real
 * thing to give up — see the honest limits below — but it would also put a row
 * on the hot path of every part fetch, and the blast radius here is already
 * one export that the holder was authorised to download when it was issued.
 *
 * Honest limits, both deliberate:
 *
 *  - It cannot be revoked before it expires. The export's own `expiresAt` is
 *    still re-checked on every use, so a retired export stops being reachable
 *    regardless of the token.
 *  - It does not re-check the user's roles on use. A user whose access is
 *    removed mid-download keeps this one export until the token expires. Keep
 *    the TTL short enough that this is a window, not a hole.
 */

/** Bumped if the payload shape changes, so old tokens fail closed. */
const TOKEN_VERSION = 1;

/**
 * The signing key is DERIVED from the session secret, never the secret itself.
 * Two different things signed with one key means a flaw in either becomes a
 * flaw in both, and it makes rotating one impossible without breaking the other.
 */
const KEY_INFO = 'cdfir.export-download-token.v1';

export interface DownloadTokenClaims {
  tenantId: string;
  exportId: string;
  userId: string;
  /** Unix seconds. */
  expiresAt: number;
}

function signingKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(KEY_INFO).digest();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign a token for one export.
 *
 * `issuedAtMs` is injectable so tests can pin expiry without faking the clock
 * globally.
 */
export function signDownloadToken(
  sessionSecret: string,
  claims: Omit<DownloadTokenClaims, 'expiresAt'>,
  ttlSeconds: number,
  issuedAtMs: number = Date.now(),
): string {
  const payload = {
    v: TOKEN_VERSION,
    t: claims.tenantId,
    e: claims.exportId,
    u: claims.userId,
    exp: Math.floor(issuedAtMs / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac('sha256', signingKey(sessionSecret)).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify and decode a token. Returns null for anything that is not a valid,
 * unexpired token — never throws, and never says WHY it failed.
 *
 * The caller turns null into a flat 401. Distinguishing "bad signature" from
 * "expired" from "wrong export" would tell someone probing this exactly which
 * part of their guess was right.
 */
export function verifyDownloadToken(
  sessionSecret: string,
  token: string,
  nowMs: number = Date.now(),
): DownloadTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];

  const expected = createHmac('sha256', signingKey(sessionSecret)).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // thrown error is itself a signal about the input.
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const claims = decoded as Record<string, unknown>;
  if (claims['v'] !== TOKEN_VERSION) return null;
  const tenantId = claims['t'];
  const exportId = claims['e'];
  const userId = claims['u'];
  const exp = claims['exp'];
  if (
    typeof tenantId !== 'string' ||
    typeof exportId !== 'string' ||
    typeof userId !== 'string' ||
    typeof exp !== 'number'
  ) {
    return null;
  }
  if (exp * 1000 <= nowMs) return null;

  return { tenantId, exportId, userId, expiresAt: exp };
}
