import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TenantRole } from '@aeg-clouddfir/database';
import { TenantsService } from './tenants.service.js';
import { hashInviteToken } from './invite-token.js';
import { QUOTA_DEFAULTS } from '../common/quotas.js';
import {
  TENANT_ID,
  USER_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

function makeService(
  models: Record<string, unknown>,
  configOverrides: Parameters<typeof testConfig>[0] = {},
) {
  const audit = fakeAudit();
  const prisma = fakePrisma(models);
  const service = new TenantsService(
    prisma,
    testConfig({ CDFIR_SELF_SERVE_SIGNUP: true, ...configOverrides }),
    audit.service,
  );
  return { service, audit, prisma };
}

describe('TenantsService.createSelfServe', () => {
  it('refuses when the feature flag is off', async () => {
    const { service } = makeService({}, { CDFIR_SELF_SERVE_SIGNUP: false });
    await expect(
      service.createSelfServe(USER_ID, { name: 'Acme', slug: 'acme' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a reserved slug', async () => {
    const { service } = makeService({
      membership: { count: vi.fn(async () => 0) },
    });
    await expect(
      service.createSelfServe(USER_ID, { name: 'Us', slug: 'evestigate' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rate-limits a second create inside the cooldown window', async () => {
    const { service } = makeService({
      membership: { count: vi.fn(async () => 1) },
    });
    const err = await service
      .createSelfServe(USER_ID, { name: 'Acme', slug: 'acme' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('creates the tenant with billing none, default quotas, and org_admin membership', async () => {
    const tenantCreate = vi.fn(async () => ({
      id: TENANT_ID,
      name: 'Acme',
      slug: 'acme',
    }));
    const membershipCreate = vi.fn(async () => ({ id: 'mem-1' }));
    const roleCreate = vi.fn(async () => ({ id: 'role-1' }));
    const { service, audit } = makeService({
      membership: { count: vi.fn(async () => 0), create: membershipCreate },
      tenant: { create: tenantCreate },
      roleAssignment: { create: roleCreate },
    });

    const result = await service.createSelfServe(
      USER_ID,
      { name: 'Acme', slug: 'Acme' },
      fakeRequest(),
    );
    expect(result).toEqual({ tenantId: TENANT_ID, name: 'Acme', slug: 'acme' });

    const createdData = tenantCreate.mock.calls[0]?.[0] as {
      data: {
        billingStatus: string;
        planQuota: Record<string, number>;
        slug: string;
        joinToken?: string;
      };
    };
    expect(createdData.data.slug).toBe('acme');
    expect(createdData.data.billingStatus).toBe('none');
    expect(createdData.data.planQuota).toEqual(QUOTA_DEFAULTS);
    expect(typeof createdData.data.joinToken).toBe('string');
    expect((createdData.data.joinToken as string).length).toBeGreaterThan(16);
    expect(roleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: TenantRole.org_admin, source: 'local' }),
      }),
    );
    expect(audit.appendTx).toHaveBeenCalledTimes(2);
    expect(audit.appendTx.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual([
      'tenant.created',
      'tenant.member_joined',
    ]);
  });

  it('maps a unique slug clash to a conflict', async () => {
    const { service } = makeService({
      membership: { count: vi.fn(async () => 0), create: vi.fn() },
      tenant: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('clash', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }),
      },
      roleAssignment: { create: vi.fn() },
    });
    await expect(
      service.createSelfServe(USER_ID, { name: 'Acme', slug: 'acme' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TenantsService.createInvite', () => {
  it('stores a hash, not the raw token, and returns a join URL', async () => {
    const create = vi.fn(async (args: { data: { tokenHash: string } }) => ({
      id: 'invite-1',
      email: args.data.tokenHash ? 'pat@example.com' : '',
      role: TenantRole.reviewer,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    }));
    create.mockImplementation(
      async (args: { data: { email: string; tokenHash: string; role: TenantRole } }) => ({
        id: 'invite-1',
        email: args.data.email,
        role: args.data.role,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    );
    const { service, audit } = makeService({
      tenantInvite: { create },
    });
    const auth = makeAuth([TenantRole.org_admin]);
    const result = await service.createInvite(
      auth,
      { email: 'Pat@Example.com', role: TenantRole.reviewer },
      fakeRequest(),
    );
    expect(result.email).toBe('pat@example.com');
    expect(result.inviteUrl).toMatch(/^https:\/\/app\.ev\.test\/signup\?token=/);
    const stored = create.mock.calls[0]?.[0] as { data: { tokenHash: string } };
    const token = new URL(result.inviteUrl).searchParams.get('token') ?? '';
    expect(stored.data.tokenHash).toBe(hashInviteToken(token));
    expect(stored.data.tokenHash).not.toBe(token);
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'tenant.invite_created' }),
    );
  });
});

describe('TenantsService.redeemInvite', () => {
  const token = 'a'.repeat(32);
  const future = new Date(Date.now() + 86_400_000);

  it('rejects a missing, used, or expired invite without saying which', async () => {
    const { service } = makeService({
      tenantInvite: { findUnique: vi.fn(async () => null) },
      tenant: { findFirst: vi.fn(async () => null) },
    });
    await expect(service.redeemInvite(USER_ID, token)).rejects.toBeInstanceOf(NotFoundException);

    const { service: used } = makeService({
      tenantInvite: {
        findUnique: vi.fn(async () => ({
          id: 'inv-1',
          tenantId: TENANT_ID,
          email: 'pat@example.com',
          role: TenantRole.reviewer,
          expiresAt: future,
          usedAt: new Date(),
        })),
      },
    });
    await expect(used.redeemInvite(USER_ID, token)).rejects.toBeInstanceOf(NotFoundException);

    const { service: expired } = makeService({
      tenantInvite: {
        findUnique: vi.fn(async () => ({
          id: 'inv-1',
          tenantId: TENANT_ID,
          email: 'pat@example.com',
          role: TenantRole.reviewer,
          expiresAt: new Date(Date.now() - 1000),
          usedAt: null,
        })),
      },
    });
    await expect(expired.redeemInvite(USER_ID, token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when the signed-in email does not match the invite', async () => {
    const { service } = makeService({
      tenantInvite: {
        findUnique: vi.fn(async () => ({
          id: 'inv-1',
          tenantId: TENANT_ID,
          email: 'pat@example.com',
          role: TenantRole.reviewer,
          expiresAt: future,
          usedAt: null,
        })),
      },
      user: { findUnique: vi.fn(async () => ({ id: USER_ID, email: 'other@example.com' })) },
    });
    await expect(service.redeemInvite(USER_ID, token)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates membership, grants the invited role, and marks the invite used', async () => {
    const membershipCreate = vi.fn(async () => ({ id: 'mem-1' }));
    const roleCreate = vi.fn(async () => ({ id: 'role-1' }));
    const inviteUpdate = vi.fn(async () => ({ id: 'inv-1' }));
    const { service, audit } = makeService({
      tenantInvite: {
        findUnique: vi.fn(async () => ({
          id: 'inv-1',
          tenantId: TENANT_ID,
          email: 'pat@example.com',
          role: TenantRole.reviewer,
          expiresAt: future,
          usedAt: null,
        })),
        update: inviteUpdate,
      },
      user: { findUnique: vi.fn(async () => ({ id: USER_ID, email: 'Pat@example.com' })) },
      tenant: {
        findUnique: vi.fn(async () => ({
          id: TENANT_ID,
          name: 'Acme',
          slug: 'acme',
          status: 'active',
        })),
      },
      membership: {
        findUnique: vi.fn(async () => null),
        create: membershipCreate,
      },
      roleAssignment: { findUnique: vi.fn(async () => null), create: roleCreate },
    });

    const result = await service.redeemInvite(USER_ID, token, fakeRequest());
    expect(result).toEqual({ tenantId: TENANT_ID, name: 'Acme', slug: 'acme' });
    expect(membershipCreate).toHaveBeenCalled();
    expect(roleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: TenantRole.reviewer, source: 'local' }),
      }),
    );
    expect(inviteUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv-1' } }));
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'tenant.member_joined' }),
    );
  });

  it('redeems a standing join link without matching email and does not consume it', async () => {
    const membershipCreate = vi.fn(async () => ({ id: 'mem-1' }));
    const roleCreate = vi.fn(async () => ({ id: 'role-1' }));
    const { service, audit } = makeService({
      tenantInvite: { findUnique: vi.fn(async () => null) },
      tenant: {
        findFirst: vi.fn(async () => ({
          id: TENANT_ID,
          name: 'Acme',
          slug: 'acme',
          status: 'active',
        })),
      },
      user: { findUnique: vi.fn(async () => ({ id: USER_ID })) },
      membership: {
        findUnique: vi.fn(async () => null),
        create: membershipCreate,
      },
      roleAssignment: { findUnique: vi.fn(async () => null), create: roleCreate },
    });

    const result = await service.redeemInvite(USER_ID, token, fakeRequest());
    expect(result).toEqual({ tenantId: TENANT_ID, name: 'Acme', slug: 'acme' });
    expect(membershipCreate).toHaveBeenCalled();
    expect(roleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: TenantRole.reviewer, source: 'local' }),
      }),
    );
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'tenant.member_joined',
        summary: expect.objectContaining({ via: 'join_link' }),
      }),
    );
  });
});

describe('TenantsService join link', () => {
  it('returns the existing standing token', async () => {
    const { service } = makeService({
      tenant: {
        findUnique: vi.fn(async () => ({ joinToken: 'standing-token-value-32chars!!' })),
      },
    });
    const result = await service.getOrCreateJoinLink(makeAuth([TenantRole.org_admin]));
    expect(result.role).toBe(TenantRole.reviewer);
    expect(result.inviteUrl).toBe(
      'https://app.ev.test/signup?token=standing-token-value-32chars!!',
    );
  });

  it('mints a token when the tenant has none yet', async () => {
    const update = vi.fn(async () => ({ id: TENANT_ID }));
    const { service } = makeService({
      tenant: {
        findUnique: vi.fn(async () => ({ joinToken: null })),
        update,
      },
    });
    const result = await service.getOrCreateJoinLink(makeAuth([TenantRole.org_admin]));
    expect(result.role).toBe(TenantRole.reviewer);
    const minted = new URL(result.inviteUrl).searchParams.get('token') ?? '';
    expect(minted.length).toBeGreaterThan(16);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { joinToken: minted } }));
  });

  it('rotates the standing token and writes an audit event', async () => {
    const update = vi.fn(async () => ({ id: TENANT_ID }));
    const { service, audit } = makeService({
      tenant: { update },
    });
    const result = await service.rotateJoinLink(makeAuth([TenantRole.org_admin]), fakeRequest());
    const minted = new URL(result.inviteUrl).searchParams.get('token') ?? '';
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { joinToken: minted } }));
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'tenant.join_link_rotated' }),
    );
  });
});
