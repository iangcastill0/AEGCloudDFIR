import { describe, expect, it } from 'vitest';
import { generateInviteToken, hashInviteToken } from './invite-token.js';
import { normalizeTenantSlug, tenantSlugError } from './tenant-slug.js';

describe('tenantSlugError', () => {
  it('accepts a normal slug', () => {
    expect(tenantSlugError('acme-corp')).toBeNull();
  });

  it('rejects reserved names even when they match the shape', () => {
    expect(tenantSlugError('evestigate')).toBe('that slug is reserved');
    expect(tenantSlugError('admin')).toBe('that slug is reserved');
    expect(tenantSlugError('staging')).toBe('that slug is reserved');
  });

  it('rejects uppercase, spaces, and a leading hyphen', () => {
    expect(tenantSlugError(normalizeTenantSlug('Acme'))).toBeNull();
    expect(tenantSlugError('Acme')).not.toBeNull();
    expect(tenantSlugError('a')).not.toBeNull();
    expect(tenantSlugError('-acme')).not.toBeNull();
  });
});

describe('invite tokens', () => {
  it('hashes the same token to the same digest and a different token to another', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toEqual(b);
    expect(hashInviteToken(a)).toHaveLength(64);
    expect(hashInviteToken(a)).toBe(hashInviteToken(a));
    expect(hashInviteToken(a)).not.toBe(hashInviteToken(b));
  });
});
