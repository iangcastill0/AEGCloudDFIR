import { describe, expect, it } from 'vitest';
import type { PrismaClient, TenantRole } from '@prisma/client';
import { bootstrapOrgAdmin, BootstrapError, DEFAULT_BOOTSTRAP_ROLES } from './bootstrap.js';

/**
 * These tests drive bootstrapOrgAdmin against an in-memory fake of the Prisma
 * surface it touches. The fake also records which RLS context each write ran
 * in, because "the tenant INSERT happened in platform context and the
 * membership INSERT happened in tenant context" is the part that would silently
 * break in production — a context mistake surfaces as an RLS denial against a
 * real database, long after this code looked fine.
 */

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface FakeState {
  tenants: { id: string; slug: string; name: string; status: string }[];
  users: {
    id: string;
    email: string;
    isPlatformAdmin: boolean;
    displayName: string;
    createdAt: Date;
  }[];
  memberships: { id: string; tenantId: string; userId: string; status: string }[];
  roleAssignments: {
    id: string;
    tenantId: string;
    membershipId: string;
    role: string;
    source: string;
  }[];
  auditEvents: { tenantId: string; action: string; targetId: string; summary: unknown }[];
  /** set_config calls, in order: ['app.platform=true', 'app.tenant_id=<id>'] */
  contexts: string[];
  /** Which context was active for each write, keyed by table. */
  writeContexts: Record<string, string[]>;
}

/**
 * Argument shapes for exactly the Prisma calls bootstrapOrgAdmin makes. Spelled
 * out rather than loosened to `any` so that changing a query in bootstrap.ts
 * without updating this fake is a type error instead of a silently passing test.
 */
interface MembershipRow {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
}
interface RoleAssignmentRow {
  id: string;
  tenantId: string;
  membershipId: string;
  role: string;
  source: string;
}
interface FakeCalls {
  tenantFindUnique: { where: { slug: string }; select?: unknown };
  tenantCreate: { data: { name: string; slug: string }; select?: unknown };
  membershipFindUnique: { where: { tenantId_userId: { tenantId: string; userId: string } } };
  membershipCreate: { data: Omit<MembershipRow, 'id'> };
  membershipUpdate: { where: { id: string }; data: { status: string } };
  roleFindUnique: { where: { membershipId_role: { membershipId: string; role: string } } };
  roleCreate: { data: Omit<RoleAssignmentRow, 'id'> };
  roleFindMany: { where: { membershipId: string } };
  auditCreate: { data: { tenantId: string; action: string; targetId: string; summary: unknown } };
  userFindMany: { where: { email: { equals: string; mode?: string } } };
  userUpdate: { where: { id: string }; data: { isPlatformAdmin?: boolean } };
}

function makeFake(seed: Partial<FakeState> = {}) {
  const s: FakeState = {
    tenants: [],
    users: [],
    memberships: [],
    roleAssignments: [],
    auditEvents: [],
    contexts: [],
    writeContexts: {},
    ...seed,
  };
  let current = 'none';
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const note = (table: string) => {
    (s.writeContexts[table] ??= []).push(current);
  };

  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('app.platform')) current = 'platform';
      else if (sql.includes('app.tenant_id')) current = `tenant:${String(vals[0])}`;
      s.contexts.push(current);
      return Promise.resolve(1);
    },
    // appendAuditEvent's internals: advisory lock, previous-event lookup, insert.
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve([{ locked: true }]);
      return Promise.resolve([]);
    },
    tenant: {
      findUnique: ({ where }: FakeCalls['tenantFindUnique']) =>
        Promise.resolve(s.tenants.find((t) => t.slug === where.slug) ?? null),
      create: ({ data }: FakeCalls['tenantCreate']) => {
        note('tenants');
        const t = { id: TENANT_ID, slug: data.slug, name: data.name, status: 'active' };
        s.tenants.push(t);
        return Promise.resolve(t);
      },
    },
    membership: {
      findUnique: ({ where }: FakeCalls['membershipFindUnique']) => {
        const k = where.tenantId_userId;
        return Promise.resolve(
          s.memberships.find((m) => m.tenantId === k.tenantId && m.userId === k.userId) ?? null,
        );
      },
      create: ({ data }: FakeCalls['membershipCreate']) => {
        note('memberships');
        const m = { id: id('mem'), ...data };
        s.memberships.push(m);
        return Promise.resolve(m);
      },
      update: ({ where, data }: FakeCalls['membershipUpdate']) => {
        note('memberships');
        const m = s.memberships.find((x) => x.id === where.id)!;
        Object.assign(m, data);
        return Promise.resolve(m);
      },
    },
    roleAssignment: {
      findUnique: ({ where }: FakeCalls['roleFindUnique']) => {
        const k = where.membershipId_role;
        return Promise.resolve(
          s.roleAssignments.find((r) => r.membershipId === k.membershipId && r.role === k.role) ??
            null,
        );
      },
      create: ({ data }: FakeCalls['roleCreate']) => {
        note('role_assignments');
        const r = { id: id('ra'), ...data };
        s.roleAssignments.push(r);
        return Promise.resolve(r);
      },
      findMany: ({ where }: FakeCalls['roleFindMany']) =>
        Promise.resolve(s.roleAssignments.filter((r) => r.membershipId === where.membershipId)),
    },
    auditEvent: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: FakeCalls['auditCreate']) => {
        note('audit_events');
        s.auditEvents.push(data);
        return Promise.resolve({ ...data, sequence: 1n });
      },
    },
  };

  const prisma = {
    $transaction: async <T>(fn: (tx: typeof tx) => Promise<T>): Promise<T> => {
      const before = current;
      try {
        return await fn(tx);
      } finally {
        current = before; // SET LOCAL does not outlive the transaction
      }
    },
    user: {
      findMany: ({ where }: FakeCalls['userFindMany']) => {
        const want = String(where.email.equals).toLowerCase();
        return Promise.resolve(s.users.filter((u) => u.email.toLowerCase() === want));
      },
      update: ({ where, data }: FakeCalls['userUpdate']) => {
        note('users');
        const u = s.users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return Promise.resolve(u);
      },
    },
  };

  // The fake implements only the slice of PrismaClient this code path uses.
  return { prisma: prisma as unknown as PrismaClient, state: s };
}

const BASE = {
  tenantSlug: 'evestigate',
  tenantName: 'Evestigate',
  email: 'ian.castillo@evestigate.com',
};

function withUser(email = BASE.email, extra: Record<string, unknown> = {}) {
  return {
    users: [
      {
        id: USER_ID,
        email,
        isPlatformAdmin: false,
        displayName: 'Ian',
        createdAt: new Date('2026-01-01'),
        ...extra,
      },
    ],
  };
}

describe('bootstrapOrgAdmin — input validation', () => {
  it.each([
    ['Evestigate Inc', 'uppercase and spaces'],
    ['a', 'too short'],
    ['-lead', 'leading hyphen'],
    ['', 'empty'],
  ])('rejects tenant slug %j (%s)', async (slug) => {
    const { prisma } = makeFake();
    await expect(bootstrapOrgAdmin(prisma, { ...BASE, tenantSlug: slug })).rejects.toThrow(
      BootstrapError,
    );
  });

  it('normalizes email case and whitespace', async () => {
    const { prisma } = makeFake(withUser('ian.castillo@evestigate.com'));
    const r = await bootstrapOrgAdmin(prisma, { ...BASE, email: '  IAN.Castillo@Evestigate.com ' });
    expect(r.email).toBe('ian.castillo@evestigate.com');
    expect(r.status).toBe('granted');
  });

  it('rejects a value that is not an email address', async () => {
    const { prisma } = makeFake();
    await expect(bootstrapOrgAdmin(prisma, { ...BASE, email: 'ian' })).rejects.toThrow(
      BootstrapError,
    );
  });

  it('rejects an empty role list rather than creating a membership with no access', async () => {
    const { prisma } = makeFake();
    await expect(bootstrapOrgAdmin(prisma, { ...BASE, roles: [] })).rejects.toThrow(BootstrapError);
  });

  it('does not create the tenant when validation fails', async () => {
    const { prisma, state } = makeFake();
    await expect(
      bootstrapOrgAdmin(prisma, { ...BASE, tenantSlug: 'Evestigate Inc' }),
    ).rejects.toThrow();
    expect(state.tenants).toHaveLength(0);
  });

  // Normalizing rather than rejecting is deliberate: if 'Evestigate' and
  // 'evestigate' were both accepted as distinct slugs, an operator could create
  // a second tenant by capitalization alone and grant admin on the wrong one.
  it('normalizes slug case and surrounding whitespace instead of rejecting', async () => {
    const { prisma, state } = makeFake(withUser());
    const r = await bootstrapOrgAdmin(prisma, { ...BASE, tenantSlug: '  Evestigate  ' });
    expect(r.tenantSlug).toBe('evestigate');
    expect(state.tenants[0]!.slug).toBe('evestigate');
  });

  it('treats a differently-cased slug as the same tenant on a re-run', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, { ...BASE, tenantSlug: 'evestigate' });
    const second = await bootstrapOrgAdmin(prisma, { ...BASE, tenantSlug: 'EVESTIGATE' });
    expect(second.tenantCreated).toBe(false);
    expect(state.tenants).toHaveLength(1);
  });
});

describe('bootstrapOrgAdmin — awaiting first login', () => {
  it('creates the tenant but reports that the user must sign in once', async () => {
    const { prisma, state } = makeFake();
    const r = await bootstrapOrgAdmin(prisma, BASE);
    expect(r.status).toBe('awaiting_first_login');
    expect(r.tenantCreated).toBe(true);
    expect(state.tenants).toHaveLength(1);
    // No membership can exist yet — there is no user row to attach it to.
    expect(state.memberships).toHaveLength(0);
    expect(state.roleAssignments).toHaveLength(0);
  });

  it('reuses the tenant on a re-run before the user has logged in', async () => {
    const { prisma, state } = makeFake();
    await bootstrapOrgAdmin(prisma, BASE);
    const second = await bootstrapOrgAdmin(prisma, BASE);
    expect(second.tenantCreated).toBe(false);
    expect(state.tenants).toHaveLength(1);
  });
});

describe('bootstrapOrgAdmin — granting', () => {
  it('grants org_admin by default and reports what it changed', async () => {
    const { prisma, state } = makeFake(withUser());
    const r = await bootstrapOrgAdmin(prisma, BASE);
    if (r.status !== 'granted') throw new Error(`expected granted, got ${r.status}`);
    expect(r.membershipCreated).toBe(true);
    expect(r.rolesAdded).toEqual([...DEFAULT_BOOTSTRAP_ROLES]);
    expect(r.rolesEffective).toEqual(['org_admin']);
    expect(state.memberships).toEqual([
      { id: expect.any(String), tenantId: TENANT_ID, userId: USER_ID, status: 'active' },
    ]);
    expect(state.roleAssignments[0]).toMatchObject({ role: 'org_admin', source: 'local' });
  });

  it('matches the email case-insensitively', async () => {
    const { prisma } = makeFake(withUser('Ian.Castillo@Evestigate.com'));
    const r = await bootstrapOrgAdmin(prisma, { ...BASE, email: 'ian.castillo@evestigate.com' });
    expect(r.status).toBe('granted');
  });

  it('is idempotent — a second run adds nothing', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, BASE);
    const second = await bootstrapOrgAdmin(prisma, BASE);
    if (second.status !== 'granted') throw new Error('expected granted');
    expect(second.membershipCreated).toBe(false);
    expect(second.rolesAdded).toEqual([]);
    expect(second.rolesEffective).toEqual(['org_admin']);
    expect(state.memberships).toHaveLength(1);
    expect(state.roleAssignments).toHaveLength(1);
  });

  it('adds only the missing role when extending an existing grant', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, BASE);
    const r = await bootstrapOrgAdmin(prisma, {
      ...BASE,
      roles: ['org_admin', 'auditor'] as TenantRole[],
    });
    if (r.status !== 'granted') throw new Error('expected granted');
    expect(r.rolesAdded).toEqual(['auditor']);
    expect(state.roleAssignments).toHaveLength(2);
  });

  it('leaves an IdP-derived role assignment alone instead of rewriting its source', async () => {
    const seed = {
      ...withUser(),
      memberships: [{ id: 'mem-existing', tenantId: TENANT_ID, userId: USER_ID, status: 'active' }],
      roleAssignments: [
        {
          id: 'ra-existing',
          tenantId: TENANT_ID,
          membershipId: 'mem-existing',
          role: 'org_admin',
          source: 'oidc_group',
        },
      ],
      tenants: [{ id: TENANT_ID, slug: 'evestigate', name: 'Evestigate', status: 'active' }],
    };
    const { prisma, state } = makeFake(seed);
    const r = await bootstrapOrgAdmin(prisma, BASE);
    if (r.status !== 'granted') throw new Error('expected granted');
    expect(r.rolesAdded).toEqual([]);
    // Still oidc_group: rewriting it to 'local' would make group sync stop
    // managing the role, so removing the user from the IdP group would no
    // longer revoke their admin access.
    expect(state.roleAssignments[0]!.source).toBe('oidc_group');
  });

  it('reactivates a suspended membership rather than creating a duplicate', async () => {
    const seed = {
      ...withUser(),
      tenants: [{ id: TENANT_ID, slug: 'evestigate', name: 'Evestigate', status: 'active' }],
      memberships: [{ id: 'mem-old', tenantId: TENANT_ID, userId: USER_ID, status: 'suspended' }],
    };
    const { prisma, state } = makeFake(seed);
    await bootstrapOrgAdmin(prisma, BASE);
    expect(state.memberships).toHaveLength(1);
    expect(state.memberships[0]!.status).toBe('active');
  });

  it('refuses when two identities share the email', async () => {
    const { prisma } = makeFake({
      users: [
        {
          id: 'u-1',
          email: BASE.email,
          isPlatformAdmin: false,
          displayName: 'a',
          createdAt: new Date(1),
        },
        {
          id: 'u-2',
          email: BASE.email,
          isPlatformAdmin: false,
          displayName: 'b',
          createdAt: new Date(2),
        },
      ],
    });
    await expect(bootstrapOrgAdmin(prisma, BASE)).rejects.toThrow(/2 users carry the email/);
  });

  it('refuses to grant admin on a non-active tenant', async () => {
    const { prisma } = makeFake({
      ...withUser(),
      tenants: [{ id: TENANT_ID, slug: 'evestigate', name: 'Evestigate', status: 'suspended' }],
    });
    await expect(bootstrapOrgAdmin(prisma, BASE)).rejects.toThrow(/suspended/);
  });
});

describe('bootstrapOrgAdmin — platform admin flag', () => {
  it('is not set unless asked for', async () => {
    const { prisma, state } = makeFake(withUser());
    const r = await bootstrapOrgAdmin(prisma, BASE);
    if (r.status !== 'granted') throw new Error('expected granted');
    expect(r.platformAdminChanged).toBe(false);
    expect(state.users[0]!.isPlatformAdmin).toBe(false);
  });

  it('sets it when requested, and reports no change on a re-run', async () => {
    const { prisma, state } = makeFake(withUser());
    const first = await bootstrapOrgAdmin(prisma, { ...BASE, platformAdmin: true });
    if (first.status !== 'granted') throw new Error('expected granted');
    expect(first.platformAdminChanged).toBe(true);
    expect(state.users[0]!.isPlatformAdmin).toBe(true);

    const second = await bootstrapOrgAdmin(prisma, { ...BASE, platformAdmin: true });
    if (second.status !== 'granted') throw new Error('expected granted');
    expect(second.platformAdminChanged).toBe(false);
  });
});

describe('bootstrapOrgAdmin — RLS contexts', () => {
  it('inserts the tenant in platform context and the membership in tenant context', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, BASE);
    expect(state.writeContexts['tenants']).toEqual(['platform']);
    expect(state.writeContexts['memberships']).toEqual([`tenant:${TENANT_ID}`]);
    expect(state.writeContexts['role_assignments']).toEqual([`tenant:${TENANT_ID}`]);
  });

  it('never writes a tenant-owned table while in platform context', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, BASE);
    for (const table of ['memberships', 'role_assignments', 'audit_events']) {
      for (const ctx of state.writeContexts[table] ?? []) {
        expect(ctx).toBe(`tenant:${TENANT_ID}`);
      }
    }
  });
});

describe('bootstrapOrgAdmin — audit', () => {
  it('records the grant in the tenant audit chain', async () => {
    const { prisma, state } = makeFake(withUser());
    await bootstrapOrgAdmin(prisma, BASE);
    expect(state.auditEvents).toHaveLength(1);
    const ev = state.auditEvents[0]!;
    expect(ev.action).toBe('tenant.bootstrap_admin');
    expect(ev.targetId).toBe(USER_ID);
    expect(ev.tenantId).toBe(TENANT_ID);
    expect(ev.summary).toMatchObject({
      email: BASE.email,
      tenantSlug: 'evestigate',
      rolesAdded: ['org_admin'],
    });
  });

  it('writes no audit event when the user has not logged in yet', async () => {
    const { prisma, state } = makeFake();
    await bootstrapOrgAdmin(prisma, BASE);
    expect(state.auditEvents).toHaveLength(0);
  });
});
