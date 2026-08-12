import { describe, expect, it, vi } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import {
  buildAuthorizationParameters,
  callbackUrl,
  extractGroups,
  mapIdTokenClaims,
  parseGroupRoleMap,
  rolesForGroups,
  validateRedirectTo,
} from './oidc-helpers.js';

describe('validateRedirectTo', () => {
  it('accepts normal same-site paths', () => {
    expect(validateRedirectTo('/')).toBe('/');
    expect(validateRedirectTo('/cases/123?tab=review')).toBe('/cases/123?tab=review');
  });

  it('falls back to / for absolute URLs', () => {
    expect(validateRedirectTo('https://evil.example')).toBe('/');
    expect(validateRedirectTo('javascript:alert(1)')).toBe('/');
  });

  it('falls back to / for protocol-relative and backslash tricks', () => {
    expect(validateRedirectTo('//evil.example/phish')).toBe('/');
    expect(validateRedirectTo('/\\evil.example')).toBe('/');
    expect(validateRedirectTo('/ok\\..\\bad')).toBe('/');
  });

  it('falls back to / for missing, empty, or non-string values', () => {
    expect(validateRedirectTo(undefined)).toBe('/');
    expect(validateRedirectTo('')).toBe('/');
    expect(validateRedirectTo(42)).toBe('/');
    expect(validateRedirectTo('relative/path')).toBe('/');
  });

  it('rejects header-splitting characters', () => {
    expect(validateRedirectTo('/x\r\nSet-Cookie: pwn=1')).toBe('/');
  });
});

describe('parseGroupRoleMap', () => {
  it('parses valid mappings, including multiple roles per group', () => {
    const map = parseGroupRoleMap(
      'cdfir-admins:org_admin,cdfir-reviewers:reviewer,cdfir-admins:auditor, cdfir-readers : read_only ',
    );
    expect(map.get('cdfir-admins')).toEqual([TenantRole.org_admin, TenantRole.auditor]);
    expect(map.get('cdfir-reviewers')).toEqual([TenantRole.reviewer]);
    expect(map.get('cdfir-readers')).toEqual([TenantRole.read_only]);
  });

  it('ignores unknown roles with a warning', () => {
    const warn = vi.fn<(message: string) => void>();
    const map = parseGroupRoleMap('cdfir-admins:superuser,cdfir-reviewers:reviewer', warn);
    expect(map.has('cdfir-admins')).toBe(false);
    expect(map.get('cdfir-reviewers')).toEqual([TenantRole.reviewer]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('superuser');
  });

  it('ignores malformed entries with a warning', () => {
    const warn = vi.fn<(message: string) => void>();
    const map = parseGroupRoleMap('nocolon,:reviewer,group:,ok:auditor', warn);
    expect([...map.keys()]).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('returns an empty map for an empty string', () => {
    const warn = vi.fn<(message: string) => void>();
    expect(parseGroupRoleMap('', warn).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not duplicate a repeated group:role pair', () => {
    const map = parseGroupRoleMap('g:reviewer,g:reviewer');
    expect(map.get('g')).toEqual([TenantRole.reviewer]);
  });
});

describe('extractGroups', () => {
  it('reads an array-of-strings claim', () => {
    expect(extractGroups({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
  });

  it('accepts a single string claim', () => {
    expect(extractGroups({ groups: 'a' }, 'groups')).toEqual(['a']);
  });

  it('filters non-string members and handles missing/odd shapes', () => {
    expect(extractGroups({ groups: ['a', 1, null, 'b'] }, 'groups')).toEqual(['a', 'b']);
    expect(extractGroups({}, 'groups')).toEqual([]);
    expect(extractGroups({ groups: { nested: true } }, 'groups')).toEqual([]);
    expect(extractGroups({ groups: ['a'] }, '')).toEqual([]);
  });
});

describe('rolesForGroups', () => {
  it('unions and de-duplicates mapped roles', () => {
    const map = new Map<string, TenantRole[]>([
      ['a', [TenantRole.org_admin, TenantRole.reviewer]],
      ['b', [TenantRole.reviewer, TenantRole.auditor]],
    ]);
    expect(rolesForGroups(['a', 'b', 'unmapped'], map).sort()).toEqual(
      [TenantRole.auditor, TenantRole.org_admin, TenantRole.reviewer].sort(),
    );
    expect(rolesForGroups([], map)).toEqual([]);
  });
});

describe('mapIdTokenClaims', () => {
  it('maps the usual claims', () => {
    expect(
      mapIdTokenClaims({ iss: 'https://idp', sub: 'abc', email: 'a@b.co', name: 'Ada' }),
    ).toEqual({ issuer: 'https://idp', subject: 'abc', email: 'a@b.co', displayName: 'Ada' });
  });

  it('falls back to preferred_username and empty email', () => {
    expect(mapIdTokenClaims({ iss: 'https://idp', sub: 'abc', preferred_username: 'ada' })).toEqual(
      { issuer: 'https://idp', subject: 'abc', email: '', displayName: 'ada' },
    );
  });

  it('returns null for unusable claims', () => {
    expect(mapIdTokenClaims(undefined)).toBeNull();
    expect(mapIdTokenClaims({ sub: 'abc' })).toBeNull();
    expect(mapIdTokenClaims({ iss: 'https://idp' })).toBeNull();
  });
});

describe('authorization parameters', () => {
  it('builds the exact OIDC + PKCE parameter set', () => {
    expect(
      buildAuthorizationParameters({
        apiPublicUrl: 'https://api.ev.example/',
        state: 'st',
        nonce: 'no',
        codeChallenge: 'ch',
      }),
    ).toEqual({
      redirect_uri: 'https://api.ev.example/auth/callback',
      scope: 'openid profile email',
      state: 'st',
      nonce: 'no',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('normalizes trailing slashes in the public URL', () => {
    expect(callbackUrl('https://api.ev.example')).toBe('https://api.ev.example/auth/callback');
    expect(callbackUrl('https://api.ev.example//')).toBe('https://api.ev.example/auth/callback');
  });
});
