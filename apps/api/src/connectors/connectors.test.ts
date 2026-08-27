import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  ConnectorStatus,
  LocalAesKeyEncryptionProvider,
  SecretKind,
  encryptSecret,
} from '@aeg-clouddfir/database';
import { TRUTHFULNESS_NOTICES, createConnectorResponse } from '@aeg-clouddfir/contracts';
import { TenantRole } from '@aeg-clouddfir/database';
import { ConnectorsService } from './connectors.service.js';
import { connectorSecretScope } from './token-provider.factory.js';
import {
  CONNECTOR_ID,
  TENANT_ID,
  TEST_KEK_BASE64,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  jsonResponse,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const kek = new LocalAesKeyEncryptionProvider({ 'kek-test': TEST_KEK_BASE64 }, 'kek-test');
const auth = makeAuth([TenantRole.org_admin]);

function baseAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    tenantId: TENANT_ID,
    provider: 'microsoft',
    mode: 'delegated',
    label: 'Mailbox',
    externalIdentity: '',
    externalTenantId: '',
    allowedDomains: [] as string[],
    status: ConnectorStatus.pending_auth,
    statusDetail: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null,
    secrets: [] as unknown[],
    ...overrides,
  };
}

function makeService(
  models: Record<string, unknown>,
  opts: {
    config?: ReturnType<typeof testConfig>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const audit = fakeAudit();
  const prisma = fakePrisma({
    tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
    ...models,
  });
  const service = new ConnectorsService(
    prisma,
    opts.config ?? testConfig(),
    kek,
    audit.service,
    opts.fetchImpl,
  );
  return { service, prisma, audit };
}

describe('ConnectorsService.list', () => {
  /**
   * A revoked connector is kept, not deleted: `Collection` and `Custodian`
   * reference it without cascade, so the row is the record of which credential
   * collected which evidence. It is hidden from the list instead.
   */
  it('leaves revoked connectors out by default', async () => {
    const findMany = vi.fn(async () => [baseAccount()]);
    const { service } = makeService({ connectorAccount: { findMany } });
    await service.list(auth, { limit: 100, cursor: null });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: TENANT_ID, status: { not: ConnectorStatus.revoked } },
    });
  });

  it('includes them when asked, so the record stays reachable', async () => {
    const findMany = vi.fn(async () => [baseAccount({ status: ConnectorStatus.revoked })]);
    const { service } = makeService({ connectorAccount: { findMany } });
    const result = await service.list(auth, { limit: 100, cursor: null }, true);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where: { tenantId: TENANT_ID } });
    // No status filter at all when revoked rows are wanted.
    const where = (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(where['status']).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });
});

describe('ConnectorsService.create', () => {
  it('builds a Microsoft authorization URL with S256 PKCE and a flow cookie', async () => {
    const created = baseAccount();
    const { service } = makeService({
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => created),
      },
    });
    const result = await service.create(
      auth,
      { provider: 'microsoft', mode: 'delegated', label: 'Mailbox' },
      fakeRequest(),
    );
    expect(result.authorizationUrl).toBeDefined();
    const url = new URL(result.authorizationUrl ?? '');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('ms-client-id');
    // state is the sealed flow, also bound to the browser via cookie
    expect(result.flowCookie?.value).toBe(url.searchParams.get('state'));
  });

  it('builds a Google authorization URL requesting offline access', async () => {
    const created = baseAccount({ provider: 'google' });
    const { service } = makeService({
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => created),
      },
    });
    const result = await service.create(
      auth,
      { provider: 'google', mode: 'delegated', label: 'Mailbox' },
      fakeRequest(),
    );
    const url = new URL(result.authorizationUrl ?? '');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('refuses with 409 when the provider OAuth app is not configured', async () => {
    const { service } = makeService({}, { config: testConfig({ CDFIR_MS_CLIENT_ID: '' }) });
    await expect(
      service.create(auth, { provider: 'microsoft', mode: 'delegated', label: 'X' }, fakeRequest()),
    ).rejects.toThrow(ConflictException);
  });

  it('returns no authorization URL for organization mode', async () => {
    const created = baseAccount({ mode: 'organization' });
    const { service } = makeService({
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => created),
      },
    });
    const result = await service.create(
      auth,
      { provider: 'microsoft', mode: 'organization', label: 'Org' },
      fakeRequest(),
    );
    expect(result.authorizationUrl).toBeUndefined();
    expect(result.flowCookie).toBeUndefined();
  });
});

describe('the create request the browser actually sends', () => {
  it('rejects a body with no label, which is what the page used to send', async () => {
    // The page posted { provider, mode } for months. Every Connect click 400d
    // here, before any provider was contacted. The shared contract schema and
    // apps/web/src/lib/connector-setup.test.ts now hold both sides together.
    const { service } = makeService({
      connectorAccount: { count: vi.fn(async () => 0), create: vi.fn(async () => baseAccount()) },
    });
    await expect(
      service.create(auth, { provider: 'google', mode: 'delegated' }, fakeRequest()),
    ).rejects.toThrow();
  });

  it('returns a body the browser can parse — the connector is NESTED', async () => {
    // The web schema expected a top-level `id`. Nothing caught it because the
    // request was rejected before the response was ever parsed; the moment the
    // request was valid, the browser failed with
    // `path: ["id"], expected string`. This asserts the real shape.
    const { service } = makeService({
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => baseAccount({ provider: 'google' })),
      },
    });
    const result = await service.create(
      auth,
      { provider: 'google', mode: 'delegated', label: 'Mailbox' },
      fakeRequest(),
    );
    const parsed = createConnectorResponse.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.connector.id).toBe(result.connector.id);
    expect(parsed.data?.authorizationUrl).toBeDefined();
  });

  it('accepts what buildCreateConnector produces', async () => {
    const { service } = makeService({
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => baseAccount({ provider: 'google' })),
      },
    });
    const result = await service.create(
      auth,
      // Exactly the shape the page now builds.
      { provider: 'google', mode: 'delegated', label: 'Google Workspace (personal) 2026-08-21' },
      fakeRequest(),
    );
    expect(result.authorizationUrl).toBeDefined();
  });
});

describe('ConnectorsService.configureOrg (google)', () => {
  const serviceAccountJson = JSON.stringify({
    client_email: 'svc@project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n',
  });

  it('never echoes key material in the response or the audit summary', async () => {
    const account = baseAccount({ provider: 'google', mode: 'organization' });
    const secretCreate = vi.fn(async () => ({}));
    const { service, audit } = makeService({
      connectorAccount: {
        findFirst: vi.fn(async () => account),
        update: vi.fn(async () => account),
      },
      connectorSecret: { deleteMany: vi.fn(async () => ({ count: 0 })), create: secretCreate },
      connectorScope: { createMany: vi.fn(async () => ({ count: 2 })) },
    });

    const result = await service.configureOrg(
      auth,
      CONNECTOR_ID,
      {
        serviceAccountJson,
        allowedDomains: ['corp.example'],
        adminEmail: 'admin@corp.example',
      },
      fakeRequest(),
    );

    expect(result.ok).toBe(true);
    // Audit DWD scopes are surfaced for setup guidance.
    expect(result.auditScopes).toContain(
      'https://www.googleapis.com/auth/admin.reports.audit.readonly',
    );
    expect(result.auditScopes).toContain('https://www.googleapis.com/auth/ediscovery.readonly');
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');

    // Stored ciphertext only — never the raw key.
    expect(secretCreate).toHaveBeenCalledTimes(1);
    const stored = secretCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(stored.data.kind).toBe(SecretKind.service_account_key);
    expect(JSON.stringify(stored.data.ciphertext)).not.toContain('SECRETKEYMATERIAL');

    // Audit summary is redacted.
    expect(audit.appendTx).toHaveBeenCalledTimes(1);
    const call = audit.appendTx.mock.calls[0]?.[1] as { summary: Record<string, unknown> };
    const summaryText = JSON.stringify(call.summary);
    expect(summaryText).not.toContain('PRIVATE KEY');
    expect(summaryText).not.toContain('SECRETKEYMATERIAL');
    expect(call.summary.adminEmail).toBe('admin@corp.example');
  });

  it('rejects a key blob without client_email/private_key', async () => {
    const account = baseAccount({ provider: 'google', mode: 'organization' });
    const { service } = makeService({
      connectorAccount: { findFirst: vi.fn(async () => account) },
    });
    await expect(
      service.configureOrg(
        auth,
        CONNECTOR_ID,
        { serviceAccountJson: '{"foo":1}', allowedDomains: ['x.com'], adminEmail: 'a@x.com' },
        fakeRequest(),
      ),
    ).rejects.toThrow('serviceAccountJson');
  });
});

describe('ConnectorsService.createImap', () => {
  function models(over: Record<string, unknown> = {}) {
    return {
      tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, quotas: {} })) },
      connectorAccount: {
        count: vi.fn(async () => 0),
        create: vi.fn(async () => baseAccount({ provider: 'imap', mode: 'delegated' })),
        update: vi.fn(async () => baseAccount({ provider: 'imap' })),
      },
      connectorSecret: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => ({})),
      },
      ...over,
    };
  }

  const body = {
    label: 'Yahoo mailbox',
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    username: 'someone@yahoo.com',
    appPassword: 'abcd efgh ijkl mnop',
  };

  it('stores the app password as ciphertext, with the plaintext nowhere in the row', async () => {
    const m = models();
    const { service } = makeService(m);
    await service.createImap(auth, body, fakeRequest());

    const args = (m.connectorSecret.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data['kind']).toBe('imap_password');
    // Envelope encryption: a wrapped DEK and ciphertext, like every other secret.
    expect(args.data['ciphertext']).toBeInstanceOf(Uint8Array);
    expect(args.data['wrappedDek']).toBeInstanceOf(Uint8Array);

    // The password must not survive anywhere in the written row, including the
    // ciphertext bytes read as text.
    const asText = Object.values(args.data)
      .map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v)))
      .join(' | ');
    expect(asText).not.toContain('abcd efgh ijkl mnop');
    expect(asText).not.toContain('someone@yahoo.com');
  });

  it('records the username as the connector identity', async () => {
    const m = models();
    const { service } = makeService(m);
    await service.createImap(auth, body, fakeRequest());
    const args = (m.connectorAccount.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data['provider']).toBe('imap');
    expect(args.data['externalIdentity']).toBe('someone@yahoo.com');
  });

  it('never writes the app password into the audit summary', async () => {
    // The audit chain is append-only and exportable. A secret in it cannot be
    // taken back out.
    const m = models();
    const { service, audit } = makeService(m);
    await service.createImap(auth, body, fakeRequest());
    const summary = JSON.stringify((audit.appendTx as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(summary).not.toContain('abcd efgh ijkl mnop');
    expect(summary).toContain('imap.mail.yahoo.com');
  });

  it('returns a body the browser can parse — the bug that made two connectors', async () => {
    // The shared provider enum was missing 'imap', so the API created the
    // connector and the BROWSER threw the response away with
    // `path: ["connector","provider"]`. The operator clicked again and ended up
    // with two connectors holding the same credential. Parsing the real return
    // value with the same schema the browser uses is the check that was missing.
    const m = models();
    const { service } = makeService(m);
    const result = await service.createImap(auth, body, fakeRequest());
    const parsed = createConnectorResponse.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.connector.provider).toBe('imap');
  });

  it('refuses imap on the OAuth create route, naming the right one', async () => {
    // There is no OAuth redirect for IMAP. Letting it through would create a
    // connector with no credential and no way to reach the mailbox.
    const { service } = makeService(models());
    await expect(
      service.create(auth, { provider: 'imap', mode: 'delegated', label: 'x' }, fakeRequest()),
    ).rejects.toThrow(/connectors\/imap/);
  });

  it('rejects a body missing the app password', async () => {
    const { service } = makeService(models());
    await expect(
      service.createImap(auth, { ...body, appPassword: '' }, fakeRequest()),
    ).rejects.toThrow();
  });
});

describe('ConnectorsService.test', () => {
  it('refreshes a token, probes mail folders, and marks the account connected', async () => {
    const encrypted = await encryptSecret(
      kek,
      TENANT_ID,
      connectorSecretScope(CONNECTOR_ID),
      Buffer.from('refresh-token-1', 'utf8'),
    );
    const account = baseAccount({
      status: ConnectorStatus.connected,
      secrets: [{ id: 'secret-1', kind: SecretKind.oauth_refresh_token, ...encrypted }],
    });
    const accountUpdate = vi.fn(async () => account);
    const fetchImpl = vi.fn(async (url: string): Promise<Response> => {
      if (url.includes('/oauth2/v2.0/token')) {
        return jsonResponse({ access_token: 'at-1', expires_in: 3600 });
      }
      if (url.includes('recoverableitemsdeletions')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (url.includes('/me/mailFolders')) {
        return jsonResponse({ value: [{ id: 'f1', displayName: 'Inbox' }] });
      }
      return jsonResponse({ error: 'unexpected url' }, 500);
    });
    const { service, audit } = makeService(
      {
        connectorAccount: {
          findFirst: vi.fn(async () => account),
          update: accountUpdate,
        },
      },
      { fetchImpl },
    );

    const result = await service.test(auth, CONNECTOR_ID, fakeRequest());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('1 mail folders');
    const update = accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(update.data.status).toBe(ConnectorStatus.connected);
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'connector.tested' }),
    );
  });

  it('records an error status with a sanitized detail on auth failure', async () => {
    const encrypted = await encryptSecret(
      kek,
      TENANT_ID,
      connectorSecretScope(CONNECTOR_ID),
      Buffer.from('refresh-token-1', 'utf8'),
    );
    const account = baseAccount({
      status: ConnectorStatus.connected,
      secrets: [{ id: 'secret-1', kind: SecretKind.oauth_refresh_token, ...encrypted }],
    });
    const accountUpdate = vi.fn(async () => account);
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    );
    const { service } = makeService(
      { connectorAccount: { findFirst: vi.fn(async () => account), update: accountUpdate } },
      { fetchImpl },
    );

    const result = await service.test(auth, CONNECTOR_ID, fakeRequest());
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain('refresh-token-1');
    const update = accountUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(update.data.status).toBe(ConnectorStatus.error);
  });
});

describe('ConnectorsService.custodians', () => {
  it('delegated mode returns only the connected identity plus the truthfulness notice', async () => {
    const account = baseAccount({ status: ConnectorStatus.connected });
    const { service } = makeService({
      connectorAccount: { findFirst: vi.fn(async () => account) },
      custodian: {
        findMany: vi.fn(async () => [
          {
            id: 'cust-1',
            externalId: 'ext-1',
            email: 'owner@example.com',
            displayName: 'Owner',
          },
        ]),
      },
    });
    const result = await service.custodians(auth, CONNECTOR_ID, {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.email).toBe('owner@example.com');
    expect(result.notice).toBe(TRUTHFULNESS_NOTICES.delegatedAccess);
    expect(result.nextCursor).toBeNull();
  });
});

describe('ConnectorsService.revoke', () => {
  it('deletes stored secrets, marks the account revoked, and returns a provider note', async () => {
    const account = baseAccount({ status: ConnectorStatus.connected });
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const update = vi.fn(async () => account);
    const { service, audit } = makeService({
      connectorAccount: { findFirst: vi.fn(async () => account), update },
      connectorSecret: { deleteMany },
    });

    const result = await service.revoke(auth, CONNECTOR_ID, fakeRequest());
    expect(result.ok).toBe(true);
    expect(result.providerRevocationNote).toContain('myaccount.microsoft.com');
    expect(deleteMany).toHaveBeenCalledWith({ where: { connectorAccountId: CONNECTOR_ID } });
    const updateArgs = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArgs.data.status).toBe(ConnectorStatus.revoked);
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'connector.revoked',
        summary: expect.objectContaining({ secretsDeleted: 2 }),
      }),
    );
  });
});
