import { describe, expect, it } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import { makeAuth, MEMBERSHIP_ID, USER_ID } from '../testing/mocks.js';
import { importReadableEvidenceWhere, mayReadImport } from './import-access.js';

describe('mayReadImport', () => {
  it('allows the uploader and org admins before case attachment', () => {
    expect(mayReadImport(makeAuth([TenantRole.case_manager]), USER_ID, false)).toBe(true);
    expect(
      mayReadImport(
        makeAuth([TenantRole.org_admin], { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        USER_ID,
        false,
      ),
    ).toBe(true);
  });

  it('hides an unattached import from other tenant users', () => {
    expect(
      mayReadImport(
        makeAuth([TenantRole.case_manager], {
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        USER_ID,
        false,
      ),
    ).toBe(false);
  });

  it('allows an assigned case member after attachment', () => {
    expect(
      mayReadImport(
        makeAuth([TenantRole.read_only], {
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        USER_ID,
        true,
      ),
    ).toBe(true);
  });
});

describe('importReadableEvidenceWhere', () => {
  it('does not restrict org admins', () => {
    expect(importReadableEvidenceWhere(makeAuth([TenantRole.org_admin]))).toEqual({});
  });

  it("keeps non-import evidence and fences everyone else's unattached imports", () => {
    const where = importReadableEvidenceWhere(makeAuth([TenantRole.case_manager]));
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { importId: null },
        { forensicImport: { is: { createdById: USER_ID } } },
      ]),
    );
    expect(JSON.stringify(where)).toContain(MEMBERSHIP_ID);
    expect(JSON.stringify(where)).not.toContain('org_admin');
  });
});
