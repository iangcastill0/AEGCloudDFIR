import { describe, expect, it } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import { ROLES_KEY } from '../auth/guards/require-roles.decorator.js';
import { EvidenceController } from '../evidence/evidence.controller.js';
import { SearchController, SavedSearchesController } from '../search/search.controller.js';
import { TagsController } from '../tags/tags.controller.js';
import { EVIDENCE_READ_ROLES } from './roles.js';

function rolesOn(target: object, key: string): TenantRole[] {
  const handler = (target as Record<string, unknown>)[key];
  return (Reflect.getMetadata(ROLES_KEY, handler as object) ?? []) as TenantRole[];
}

describe('EVIDENCE_READ_ROLES', () => {
  it('lists org_admin so self-serve and bootstrap owners can Review', () => {
    expect(EVIDENCE_READ_ROLES).toContain(TenantRole.org_admin);
  });
});

describe('Review routes list org_admin explicitly', () => {
  // RequireRoles is exact: org_admin implies nothing. Native download already
  // listed it; search and detail did not, so an org_admin who collected
  // evidence could not open Review.
  it('search execute, fields, and explain use EVIDENCE_READ_ROLES', () => {
    expect(rolesOn(SearchController.prototype, 'execute')).toEqual(EVIDENCE_READ_ROLES);
    expect(rolesOn(SearchController.prototype, 'fields')).toEqual(EVIDENCE_READ_ROLES);
    expect(rolesOn(SearchController.prototype, 'explain')).toEqual(EVIDENCE_READ_ROLES);
  });

  it('every evidence GET uses EVIDENCE_READ_ROLES, including detail', () => {
    for (const method of [
      'detail',
      'headers',
      'auditRecords',
      'family',
      'chain',
      'preview',
      'native',
    ]) {
      expect(rolesOn(EvidenceController.prototype, method)).toEqual(EVIDENCE_READ_ROLES);
    }
  });

  it('saved searches and tag bulk include org_admin', () => {
    const saved = Reflect.getMetadata(ROLES_KEY, SavedSearchesController) as TenantRole[];
    expect(saved).toContain(TenantRole.org_admin);
    expect(rolesOn(TagsController.prototype, 'bulk')).toContain(TenantRole.org_admin);
  });
});
