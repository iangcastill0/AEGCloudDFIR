import { describe, expect, it, vi } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import type { AppLogger } from '../common/logger.js';
import { AuthService } from './auth.service.js';
import { OTHER_TENANT_ID, TENANT_ID, USER_ID, fakePrisma } from '../testing/mocks.js';

const HOME_MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333331';
const GUEST_MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333332';

function fakeLogger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger;
}

function membership(opts: {
  id: string;
  tenantId: string;
  roles: { role: TenantRole; source: string }[];
}) {
  return {
    id: opts.id,
    tenantId: opts.tenantId,
    userId: USER_ID,
    status: 'active' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    tenant: { id: opts.tenantId },
    roles: opts.roles,
  };
}

function makeService(
  memberships: ReturnType<typeof membership>[],
  roleAssignment: {
    deleteMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  },
) {
  const prisma = fakePrisma({
    membership: { findMany: vi.fn(async () => memberships) },
    roleAssignment,
  });
  return { service: new AuthService(prisma, fakeLogger()), prisma, roleAssignment };
}

describe('AuthService.syncOidcGroupRoles', () => {
  it('does not copy IdP org_admin onto a standing-join reviewer membership', async () => {
    const roleAssignment = {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'ra-new' })),
    };
    const { service } = makeService(
      [
        membership({
          id: GUEST_MEMBERSHIP_ID,
          tenantId: OTHER_TENANT_ID,
          roles: [{ role: TenantRole.reviewer, source: 'local' }],
        }),
      ],
      roleAssignment,
    );

    await service.syncOidcGroupRoles(USER_ID, [TenantRole.org_admin]);

    expect(roleAssignment.create).not.toHaveBeenCalled();
    expect(roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: GUEST_MEMBERSHIP_ID, source: 'oidc_group' },
    });
  });

  it('strips an oidc_group org_admin that landed on a guest membership', async () => {
    const roleAssignment = {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: 'ra-existing' })),
      create: vi.fn(async () => ({ id: 'ra-new' })),
    };
    const { service } = makeService(
      [
        membership({
          id: GUEST_MEMBERSHIP_ID,
          tenantId: OTHER_TENANT_ID,
          roles: [
            { role: TenantRole.reviewer, source: 'local' },
            { role: TenantRole.org_admin, source: 'oidc_group' },
          ],
        }),
      ],
      roleAssignment,
    );

    await service.syncOidcGroupRoles(USER_ID, [TenantRole.org_admin]);

    expect(roleAssignment.create).not.toHaveBeenCalled();
    expect(roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: GUEST_MEMBERSHIP_ID, source: 'oidc_group' },
    });
  });

  it('still syncs mapped roles onto a tenant the person already administers', async () => {
    const home = membership({
      id: HOME_MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      roles: [{ role: TenantRole.org_admin, source: 'local' }],
    });
    const roleAssignment = {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(
        async (args: {
          where: { membershipId_role: { membershipId: string; role: TenantRole } };
        }) => {
          const hit = home.roles.find((row) => row.role === args.where.membershipId_role.role);
          return hit ? { id: 'existing' } : null;
        },
      ),
      create: vi.fn(async () => ({ id: 'ra-new' })),
    };
    const { service } = makeService([home], roleAssignment);

    await service.syncOidcGroupRoles(USER_ID, [TenantRole.org_admin, TenantRole.case_manager]);

    // org_admin already exists locally (unique on membershipId+role), so only
    // the extra mapped role is inserted as oidc_group.
    expect(roleAssignment.create).toHaveBeenCalledTimes(1);
    expect(roleAssignment.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        membershipId: HOME_MEMBERSHIP_ID,
        role: TenantRole.case_manager,
        source: 'oidc_group',
      },
    });
  });

  it('syncs the home tenant and leaves a guest tenant as reviewer only', async () => {
    const home = membership({
      id: HOME_MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      roles: [{ role: TenantRole.org_admin, source: 'local' }],
    });
    const guest = membership({
      id: GUEST_MEMBERSHIP_ID,
      tenantId: OTHER_TENANT_ID,
      roles: [{ role: TenantRole.reviewer, source: 'local' }],
    });
    const created: { membershipId: string; role: TenantRole }[] = [];
    const roleAssignment = {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(
        async (args: {
          where: { membershipId_role: { membershipId: string; role: TenantRole } };
        }) => {
          const mem = args.where.membershipId_role.membershipId === home.id ? home : guest;
          const hit = mem.roles.find((row) => row.role === args.where.membershipId_role.role);
          return hit ? { id: 'existing' } : null;
        },
      ),
      create: vi.fn(async (args: { data: { membershipId: string; role: TenantRole } }) => {
        created.push({ membershipId: args.data.membershipId, role: args.data.role });
        return { id: 'ra-new' };
      }),
    };
    const { service } = makeService([home, guest], roleAssignment);

    await service.syncOidcGroupRoles(USER_ID, [TenantRole.org_admin, TenantRole.case_manager]);

    expect(created).toEqual([{ membershipId: HOME_MEMBERSHIP_ID, role: TenantRole.case_manager }]);
    expect(roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: GUEST_MEMBERSHIP_ID, source: 'oidc_group' },
    });
  });
});
