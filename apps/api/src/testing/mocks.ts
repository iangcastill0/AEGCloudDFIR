import { vi, type Mock } from 'vitest';
import type { AppConfig } from '@evidencevault/config';
import { TenantRole, type PrismaClient } from '@evidencevault/database';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../common/http.js';
import type { AuditService } from '../audit/audit.service.js';

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
export const MEMBERSHIP_ID = '33333333-3333-4333-8333-333333333333';
export const CONNECTOR_ID = '44444444-4444-4444-8444-444444444444';
export const CASE_ID = '55555555-5555-4555-8555-555555555555';
export const TAG_ID = '66666666-6666-4666-8666-666666666666';
export const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ITEM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export function makeAuth(roles: TenantRole[], overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    membershipId: MEMBERSHIP_ID,
    roles,
    isPlatformAdmin: false,
    actorDisplay: 'Test Actor',
    ...overrides,
  };
}

/**
 * Structural PrismaClient double. Model delegates come from the caller;
 * $transaction runs the callback against the SAME object so code inside
 * withTenantContext sees the same mocks.
 */
export function fakePrisma(models: Record<string, unknown>): PrismaClient {
  const base: Record<string, unknown> = {
    $executeRaw: vi.fn(async () => 0),
    ...models,
  };
  base.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(base));
  return base as unknown as PrismaClient;
}

export interface FakeAudit {
  service: AuditService;
  append: Mock;
  appendTx: Mock;
}

export function fakeAudit(): FakeAudit {
  const append = vi.fn(async () => ({ id: 'audit-id', sequence: 1n }));
  const appendTx = vi.fn(async () => ({ id: 'audit-id', sequence: 1n }));
  return { service: { append, appendTx } as unknown as AuditService, append, appendTx };
}

export function fakeRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    method: 'POST',
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
    evRequestId: 'req-1',
    ...overrides,
  } as unknown as FastifyRequest;
}

export const TEST_KEK_BASE64 = Buffer.alloc(32, 7).toString('base64');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    EV_SESSION_SECRET: 'test-session-secret-with-32-chars-min!',
    EV_API_PUBLIC_URL: 'https://api.ev.test',
    EV_WEB_PUBLIC_URL: 'https://app.ev.test',
    EV_MS_CLIENT_ID: 'ms-client-id',
    EV_MS_CLIENT_SECRET: 'ms-client-secret',
    EV_MS_REDIRECT_PATH: '/api/v1/connectors/callback/microsoft',
    EV_GOOGLE_CLIENT_ID: 'google-client-id',
    EV_GOOGLE_CLIENT_SECRET: 'google-client-secret',
    EV_GOOGLE_REDIRECT_PATH: '/api/v1/connectors/callback/google',
    EV_MS_GRAPH_BASE_URL: 'https://graph.test/v1.0',
    EV_MS_LOGIN_BASE_URL: 'https://login.test',
    EV_GOOGLE_API_BASE_URL: 'https://google.test',
    EV_GOOGLE_OAUTH_TOKEN_URL: 'https://google.test/token',
    EV_KEK_LOCAL_MASTER_KEY: TEST_KEK_BASE64,
    EV_KEK_ACTIVE_KEY_ID: 'kek-test',
    EV_S3_PRESIGN_TTL_SECONDS: 300,
    ...overrides,
  } as AppConfig;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
