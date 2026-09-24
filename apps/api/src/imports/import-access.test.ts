import { describe, expect, it } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import { makeAuth, USER_ID } from '../testing/mocks.js';
import { mayReadImport } from './import-access.js';

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
