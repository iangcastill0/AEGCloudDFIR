import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { TenantRole, type PrismaClient } from '@aeg-clouddfir/database';
import type { AuthService, MembershipWithTenantAndRoles } from '../auth/auth.service.js';
import { createSessionPayload } from '../auth/session.js';
import { OTHER_TENANT_ID, TENANT_ID, USER_ID, fakeRequest } from '../testing/mocks.js';
import { MeController } from './me.controller.js';

function membership(over: {
  tenantId?: string;
  invited?: boolean;
  name?: string;
  slug?: string;
  role?: TenantRole;
}): MembershipWithTenantAndRoles {
  const tenantId = over.tenantId ?? TENANT_ID;
  return {
    tenantId,
    invited: over.invited ?? false,
    tenant: {
      id: tenantId,
      name: over.name ?? 'Acme',
      slug: over.slug ?? 'acme',
    },
    roles: [{ role: over.role ?? TenantRole.org_admin }],
  } as MembershipWithTenantAndRoles;
}

function makeController(memberships: MembershipWithTenantAndRoles[]) {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: USER_ID,
        email: 'owner@example.com',
        displayName: 'Owner',
      })),
    },
  } as unknown as PrismaClient;
  const authService = {
    listMemberships: vi.fn(async () => memberships),
  } as unknown as AuthService;
  return new MeController(prisma, authService);
}

function requestWithTenant(tenantId: string | undefined) {
  return fakeRequest({
    method: 'GET',
    cdfirSession: createSessionPayload(USER_ID, tenantId, 3600),
  });
}

describe('MeController invited flag', () => {
  it('reports invited from the active tenant membership only', async () => {
    // A guest invite on another tenant used to flip invited=true for every
    // tenant, which would skip the plan wall on an unpaid self-serve org.
    const controller = makeController([
      membership({ invited: false, name: 'Self Serve', slug: 'self-serve' }),
      membership({
        tenantId: OTHER_TENANT_ID,
        invited: true,
        name: 'Guest Org',
        slug: 'guest',
        role: TenantRole.reviewer,
      }),
    ]);

    const me = await controller.me(requestWithTenant(TENANT_ID));
    expect(me.invited).toBe(false);
    expect(me.tenant).toEqual({ id: TENANT_ID, name: 'Self Serve', slug: 'self-serve' });
  });

  it('is true when the active membership actually came from an invite', async () => {
    const controller = makeController([membership({ invited: true, role: TenantRole.reviewer })]);
    const me = await controller.me(requestWithTenant(TENANT_ID));
    expect(me.invited).toBe(true);
  });

  it('is false for a self-serve owner with no other memberships', async () => {
    const controller = makeController([membership({ invited: false })]);
    const me = await controller.me(requestWithTenant(TENANT_ID));
    expect(me.invited).toBe(false);
  });

  it('refuses a request with no session', async () => {
    const controller = makeController([]);
    await expect(controller.me(fakeRequest({ method: 'GET' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
