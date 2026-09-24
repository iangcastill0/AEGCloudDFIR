/**
 * Tenant slug rules for self-serve create. Same shape as the bootstrap CLI
 * (`^[a-z0-9][a-z0-9-]{1,62}$`) plus a reserved list so a new org cannot
 * impersonate the platform tenant or look like an admin path.
 */

export const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const RESERVED_TENANT_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'auth',
  'authentik',
  'cdfir',
  'clouddfir',
  'default',
  'demo',
  'evestigate',
  'join',
  'login',
  'platform',
  'root',
  'staging',
  'system',
  'test',
  'www',
]);

export function normalizeTenantSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

export function tenantSlugError(slug: string): string | null {
  if (!TENANT_SLUG_RE.test(slug)) {
    return 'slug must be 2-63 characters of lowercase letters, numbers, and hyphens, starting with a letter or number';
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return 'that slug is reserved';
  }
  return null;
}
