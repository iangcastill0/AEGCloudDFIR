import { TenantRole } from '@aeg-clouddfir/database';
import { z } from 'zod';

/**
 * Pure, unit-testable pieces of the OIDC login flow. Everything that talks to
 * the network lives in the thin OidcService adapter instead.
 */

const VALID_ROLES: ReadonlySet<string> = new Set<string>(Object.values(TenantRole));

/**
 * Only allow same-site relative paths: must start with '/' and must not be
 * protocol-relative ('//...') or backslash-tricked ('/\...'). Anything else
 * falls back to '/'.
 */
export function validateRedirectTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '/';
  if (!input.startsWith('/')) return '/';
  if (input.startsWith('//')) return '/';
  if (input.includes('\\')) return '/';
  if (/[\r\n]/.test(input)) return '/';
  return input;
}

/**
 * Parse CDFIR_OIDC_GROUP_ROLE_MAP ("group:role,group:role"). Unknown roles and
 * malformed entries are skipped with a warning; an empty string yields an
 * empty map. A group may map to multiple roles via repeated entries.
 */
export function parseGroupRoleMap(
  raw: string,
  warn: (message: string) => void = () => undefined,
): Map<string, TenantRole[]> {
  const map = new Map<string, TenantRole[]>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      warn(
        `CDFIR_OIDC_GROUP_ROLE_MAP entry "${trimmed}" is malformed (expected group:role); ignored`,
      );
      continue;
    }
    const group = trimmed.slice(0, idx).trim();
    const role = trimmed.slice(idx + 1).trim();
    if (group.length === 0) {
      warn(`CDFIR_OIDC_GROUP_ROLE_MAP entry "${trimmed}" has an empty group; ignored`);
      continue;
    }
    if (!VALID_ROLES.has(role)) {
      warn(
        `CDFIR_OIDC_GROUP_ROLE_MAP entry "${trimmed}" references unknown role "${role}"; ignored`,
      );
      continue;
    }
    const tenantRole = role as TenantRole;
    const existing = map.get(group);
    if (existing) {
      if (!existing.includes(tenantRole)) existing.push(tenantRole);
    } else {
      map.set(group, [tenantRole]);
    }
  }
  return map;
}

/** Read the configured group claim; accepts an array of strings or a single string. */
export function extractGroups(claims: Record<string, unknown>, groupClaim: string): string[] {
  if (groupClaim.length === 0) return [];
  const value = claims[groupClaim];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  return [];
}

/** Union of mapped roles for the user's groups, de-duplicated. */
export function rolesForGroups(
  groups: readonly string[],
  map: ReadonlyMap<string, TenantRole[]>,
): TenantRole[] {
  const roles = new Set<TenantRole>();
  for (const group of groups) {
    for (const role of map.get(group) ?? []) roles.add(role);
  }
  return [...roles];
}

const idTokenSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
});

export interface MappedClaims {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}

/** Narrow raw ID-token claims into what user upsert needs; null when unusable. */
export function mapIdTokenClaims(claims: unknown): MappedClaims | null {
  const parsed = idTokenSchema.safeParse(claims);
  if (!parsed.success) return null;
  const { iss, sub, email, name, preferred_username } = parsed.data;
  return {
    issuer: iss,
    subject: sub,
    email: email ?? '',
    displayName: name ?? preferred_username ?? '',
  };
}

export interface AuthorizationParamsInput {
  apiPublicUrl: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Parameters for client.buildAuthorizationUrl. */
export function buildAuthorizationParameters(
  input: AuthorizationParamsInput,
): Record<string, string> {
  return {
    redirect_uri: callbackUrl(input.apiPublicUrl),
    scope: 'openid profile email',
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  };
}

export function callbackUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/auth/callback`;
}
