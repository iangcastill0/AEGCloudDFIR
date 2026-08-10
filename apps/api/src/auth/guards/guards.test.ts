import { describe, expect, it, vi } from 'vitest';
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { TenantRole, type PrismaClient } from '@evidencevault/database';
import type { AppConfig } from '@evidencevault/config';
import {
  createSessionPayload,
  deriveSealingKey,
  sealSession,
} from '../session.js';
import type { AuthContext } from '../../common/http.js';
import type { SessionPayload } from '../session.js';
import { SessionGuard } from './session.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { RolesGuard } from './roles.guard.js';

const SECRET = 'guard-test-session-secret-at-least-32-chars';
const KEY = deriveSealingKey(SECRET);
const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT_ID = '12345678-1234-4234-8234-123456789012';

interface FakeRequest {
  method: string;
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  evSession?: SessionPayload;
  evAuth?: AuthContext;
}

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return { method: 'GET', cookies: {}, headers: {}, ...overrides };
}

function contextFor(request: FakeRequest): ExecutionContext {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return ctx as unknown as ExecutionContext;
}

function makeReflector(value: unknown): Reflector {
  return { getAllAndOverride: vi.fn(() => value) } as unknown as Reflector;
}

const config = {
  NODE_ENV: 'test',
  EV_SESSION_SECRET: SECRET,
} as unknown as AppConfig;

describe('SessionGuard', () => {
  it('skips @Public routes entirely', () => {
    const guard = new SessionGuard(config, makeReflector(true));
    expect(guard.canActivate(contextFor(makeRequest()))).toBe(true);
  });

  it('throws 401 when no session cookie is present', () => {
    const guard = new SessionGuard(config, makeReflector(undefined));
    expect(() => guard.canActivate(contextFor(makeRequest()))).toThrow(UnauthorizedException);
  });

  it('throws 401 for an expired session cookie', () => {
    const guard = new SessionGuard(config, makeReflector(undefined));
    const expired = { ...createSessionPayload(USER_ID, undefined, 60), exp: 1, iat: 0 };
    const request = makeRequest({ cookies: { ev_session: sealSession(KEY, expired) } });
    expect(() => guard.canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });

  it('throws 401 for a tampered cookie', () => {
    const guard = new SessionGuard(config, makeReflector(undefined));
    const sealed = sealSession(KEY, createSessionPayload(USER_ID, undefined, 3600));
    const request = makeRequest({ cookies: { ev_session: `${sealed.slice(0, -4)}AAAA` } });
    expect(() => guard.canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });

  it('attaches request.evSession for a valid cookie', () => {
    const guard = new SessionGuard(config, makeReflector(undefined));
    const payload = createSessionPayload(USER_ID, TENANT_ID, 3600);
    const request = makeRequest({ cookies: { ev_session: sealSession(KEY, payload) } });
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.evSession).toEqual(payload);
  });
});

interface MembershipRow {
  id: string;
  status: string;
  roles: Array<{ role: TenantRole }>;
}

interface UserRow {
  isPlatformAdmin: boolean;
  displayName: string;
  email: string;
}

function makePrisma(user: UserRow | null, membership: MembershipRow | null): PrismaClient {
  const tx = {
    $executeRaw: vi.fn(async (): Promise<number> => 0),
    membership: { findUnique: vi.fn(async (): Promise<MembershipRow | null> => membership) },
  };
  const prisma = {
    user: { findUnique: vi.fn(async (): Promise<UserRow | null> => user) },
    $transaction: vi.fn(
      async (fn: (txArg: typeof tx) => Promise<unknown>): Promise<unknown> => fn(tx),
    ),
  };
  return prisma as unknown as PrismaClient;
}

const activeUser: UserRow = { isPlatformAdmin: false, displayName: 'Ada', email: 'ada@x.co' };
const activeMembership: MembershipRow = {
  id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  status: 'active',
  roles: [{ role: TenantRole.org_admin }, { role: TenantRole.auditor }],
};

describe('TenantGuard', () => {
  it('throws 401 when SessionGuard did not run', async () => {
    const guard = new TenantGuard(makePrisma(activeUser, activeMembership));
    await expect(guard.canActivate(contextFor(makeRequest()))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 403 when no tenant is selected', async () => {
    const guard = new TenantGuard(makePrisma(activeUser, activeMembership));
    const request = makeRequest({ evSession: createSessionPayload(USER_ID, undefined, 3600) });
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('throws 403 when there is no membership in the tenant', async () => {
    const guard = new TenantGuard(makePrisma(activeUser, null));
    const request = makeRequest({ evSession: createSessionPayload(USER_ID, TENANT_ID, 3600) });
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('throws 403 when the membership is disabled', async () => {
    const guard = new TenantGuard(makePrisma(activeUser, { ...activeMembership, status: 'disabled' }));
    const request = makeRequest({ evSession: createSessionPayload(USER_ID, TENANT_ID, 3600) });
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('attaches request.evAuth with roles from the tenant context', async () => {
    const guard = new TenantGuard(makePrisma(activeUser, activeMembership));
    const request = makeRequest({ evSession: createSessionPayload(USER_ID, TENANT_ID, 3600) });
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.evAuth).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      membershipId: activeMembership.id,
      roles: [TenantRole.org_admin, TenantRole.auditor],
      isPlatformAdmin: false,
      actorDisplay: 'Ada',
    });
  });
});

function authContext(roles: TenantRole[]): AuthContext {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    membershipId: activeMembership.id,
    roles,
    isPlatformAdmin: false,
    actorDisplay: 'Ada',
  };
}

describe('RolesGuard', () => {
  it('passes when no roles are required', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    expect(guard.canActivate(contextFor(makeRequest()))).toBe(true);
    const emptyGuard = new RolesGuard(makeReflector([]));
    expect(emptyGuard.canActivate(contextFor(makeRequest()))).toBe(true);
  });

  it('passes when the caller holds one of the required roles', () => {
    const guard = new RolesGuard(makeReflector([TenantRole.org_admin, TenantRole.auditor]));
    const request = makeRequest({ evAuth: authContext([TenantRole.auditor]) });
    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it('throws 403 when there is no intersection — org_admin implies nothing', () => {
    const guard = new RolesGuard(makeReflector([TenantRole.reviewer]));
    const request = makeRequest({ evAuth: authContext([TenantRole.org_admin]) });
    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
  });

  it('throws 403 when TenantGuard did not attach a context', () => {
    const guard = new RolesGuard(makeReflector([TenantRole.reviewer]));
    expect(() => guard.canActivate(contextFor(makeRequest()))).toThrow(ForbiddenException);
  });
});
