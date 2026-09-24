import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, URL-safe. Shown once; only the hash is stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
