import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '@aeg-clouddfir/config';
import {
  ConnectorStatus,
  Provider,
  SecretKind,
  withTenantContext,
  encryptSecret,
  type EncryptedSecret,
  type KeyEncryptionProvider,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import {
  buildGoogleAuthorizationUrl,
  buildMicrosoftAdminConsentUrl,
  buildMicrosoftAuthorizationUrl,
  ConnectorError,
  exchangeGoogleAuthorizationCode,
  exchangeMicrosoftAuthorizationCode,
  GmailConnector,
  GoogleCustodianDirectory,
  GraphCustodianDirectory,
  GraphEmailConnector,
  GOOGLE_AUDIT_DWD_SCOPES,
  GOOGLE_DELEGATED_SCOPES,
  MICROSOFT_AUDIT_ORG_APP_PERMISSIONS,
  MICROSOFT_DELEGATED_SCOPES,
  type CustodianDirectory,
  type ExchangedTokens,
  type FetchLike,
} from '@aeg-clouddfir/connectors';
import {
  TRUTHFULNESS_NOTICES,
  createConnectorRequest,
  orgGoogleSetupRequest,
  orgMicrosoftSetupRequest,
} from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, CONNECTOR_FETCH, KEY_ENCRYPTION, PRISMA } from '../common/tokens.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import type { CursorQuery } from '../common/pagination.js';
import { AuditService } from '../audit/audit.service.js';
import {
  deriveSealingKey,
  openConnectorFlow,
  sealConnectorFlow,
  type ConnectorFlowPayload,
} from '../auth/session.js';
import {
  buildConnectorTokenProvider,
  ConnectorCredentialsError,
  connectorSecretScope,
  parseServiceAccountKey,
  type ConnectorSecretRecord,
} from './token-provider.factory.js';

const CONNECT_FLOW_TTL_SECONDS = 600;

export const PROVIDER_REVOCATION_NOTES: Record<Provider, string> = {
  microsoft:
    'Stored tokens were deleted. To revoke the grant on the provider side, remove the app under https://myaccount.microsoft.com > App permissions (or via Entra admin center for organization connections).',
  google:
    'Stored tokens were deleted. To revoke the grant on the provider side, remove the app under https://myaccount.google.com/permissions (or delete the service-account key for organization connections).',
  upload:
    'There is no provider-side grant for file uploads; nothing further to revoke. Already-preserved uploaded files remain in evidence storage.',
};

// Request shapes live in @aeg-clouddfir/contracts so the web builds exactly what
// this validates. They used to be declared here, and the page's payload drifted:
// it never sent `label`, so every create returned 400.

export interface ConnectorDto {
  id: string;
  provider: string;
  mode: string;
  label: string;
  externalIdentity: string;
  externalTenantId: string;
  allowedDomains: string[];
  status: string;
  statusDetail: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CustodianDto {
  id: string;
  externalId: string;
  email: string;
  displayName: string;
}

interface ProfileInfo {
  externalId: string;
  email: string;
  displayName: string;
}

const graphProfileSchema = z.object({
  id: z.string().optional(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().optional(),
  displayName: z.string().nullable().optional(),
});

const googleProfileSchema = z.object({
  id: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});

/** Prisma Bytes columns want plain Uint8Array views over ArrayBuffer. */
function encryptedSecretColumns(encrypted: EncryptedSecret): {
  kekKeyId: string;
  wrappedDek: Uint8Array<ArrayBuffer>;
  dekIv: Uint8Array<ArrayBuffer>;
  dekTag: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
  cipherIv: Uint8Array<ArrayBuffer>;
  cipherTag: Uint8Array<ArrayBuffer>;
} {
  return {
    kekKeyId: encrypted.kekKeyId,
    wrappedDek: new Uint8Array(encrypted.wrappedDek),
    dekIv: new Uint8Array(encrypted.dekIv),
    dekTag: new Uint8Array(encrypted.dekTag),
    ciphertext: new Uint8Array(encrypted.ciphertext),
    cipherIv: new Uint8Array(encrypted.cipherIv),
    cipherTag: new Uint8Array(encrypted.cipherTag),
  };
}

type ConnectorAccountRow = {
  id: string;
  tenantId: string;
  provider: Provider;
  mode: 'delegated' | 'organization';
  label: string;
  externalIdentity: string;
  externalTenantId: string;
  allowedDomains: string[];
  status: ConnectorStatus;
  statusDetail: string;
  createdAt: Date;
  revokedAt: Date | null;
};

function toDto(row: ConnectorAccountRow): ConnectorDto {
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    label: row.label,
    externalIdentity: row.externalIdentity,
    externalTenantId: row.externalTenantId,
    allowedDomains: row.allowedDomains,
    status: row.status,
    statusDetail: row.statusDetail,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
  };
}

@Injectable()
export class ConnectorsService {
  private readonly sealingKey: Buffer;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEY_ENCRYPTION) private readonly kek: KeyEncryptionProvider,
    private readonly audit: AuditService,
    @Optional() @Inject(CONNECTOR_FETCH) private readonly fetchImpl?: FetchLike,
  ) {
    this.sealingKey = deriveSealingKey(config.CDFIR_SESSION_SECRET);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: ConnectorDto[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.connectorAccount.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const slice = rows.slice(0, page.limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map(toDto),
      nextCursor: rows.length > page.limit && last ? last.id : null,
    };
  }

  // -------------------------------------------------------------------------
  // Create + OAuth start
  // -------------------------------------------------------------------------

  private clientIdFor(providerName: Provider): string {
    return providerName === Provider.microsoft
      ? this.config.CDFIR_MS_CLIENT_ID
      : this.config.CDFIR_GOOGLE_CLIENT_ID;
  }

  private redirectUriFor(providerName: Provider): string {
    const path =
      providerName === Provider.microsoft
        ? this.config.CDFIR_MS_REDIRECT_PATH
        : this.config.CDFIR_GOOGLE_REDIRECT_PATH;
    return `${this.config.CDFIR_API_PUBLIC_URL}${path}`;
  }

  async create(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{
    connector: ConnectorDto;
    authorizationUrl?: string;
    flowCookie?: { value: string; maxAge: number };
  }> {
    const input = zodValidate(createConnectorRequest, body);

    if (input.provider === 'upload') {
      throw new BadRequestException(
        'the upload connector is managed automatically; upload container files via POST /api/v1/uploads instead',
      );
    }

    if (input.mode === 'delegated' && this.clientIdFor(input.provider).length === 0) {
      throw new ConflictException(
        `provider OAuth is not configured: set ${
          input.provider === 'microsoft' ? 'CDFIR_MS_CLIENT_ID' : 'CDFIR_GOOGLE_CLIENT_ID'
        } (and its client secret) to enable ${input.provider} connections`,
      );
    }

    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!tenant) throw new NotFoundException();
      const used = await tx.connectorAccount.count({
        where: { tenantId: auth.tenantId, status: { not: ConnectorStatus.revoked } },
      });
      assertWithinQuota('maxConnectorAccounts', used, readQuota(tenant, 'maxConnectorAccounts'));

      const created = await tx.connectorAccount.create({
        data: {
          tenantId: auth.tenantId,
          provider: input.provider,
          mode: input.mode,
          label: input.label,
          externalIdentity: '',
          status: ConnectorStatus.pending_auth,
          createdById: auth.userId,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'connector.created',
        targetType: 'connector_account',
        targetId: created.id,
        summary: { provider: input.provider, mode: input.mode, label: input.label },
        request,
      });
      return created;
    });

    if (input.mode === 'organization') {
      return { connector: toDto(row) };
    }

    const iat = Math.floor(Date.now() / 1000);
    const verifier = input.provider === 'microsoft' ? randomBytes(32).toString('base64url') : '';
    const flow: ConnectorFlowPayload = {
      v: 1,
      kind: 'connectorflow',
      connectorId: row.id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      provider: input.provider,
      verifier,
      iat,
      exp: iat + CONNECT_FLOW_TTL_SECONDS,
    };
    const state = sealConnectorFlow(this.sealingKey, flow);

    let authorizationUrl: string;
    if (input.provider === 'microsoft') {
      const codeChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
      authorizationUrl = buildMicrosoftAuthorizationUrl({
        msLoginBaseUrl: this.config.CDFIR_MS_LOGIN_BASE_URL,
        clientId: this.config.CDFIR_MS_CLIENT_ID,
        redirectUri: this.redirectUriFor(Provider.microsoft),
        scopes: MICROSOFT_DELEGATED_SCOPES,
        state,
        codeChallenge,
      });
    } else {
      authorizationUrl = buildGoogleAuthorizationUrl({
        clientId: this.config.CDFIR_GOOGLE_CLIENT_ID,
        redirectUri: this.redirectUriFor(Provider.google),
        scopes: GOOGLE_DELEGATED_SCOPES,
        state,
      });
    }

    return {
      connector: toDto(row),
      authorizationUrl,
      flowCookie: { value: state, maxAge: CONNECT_FLOW_TTL_SECONDS },
    };
  }

  // -------------------------------------------------------------------------
  // OAuth callback
  // -------------------------------------------------------------------------

  private webRedirect(query: string): string {
    return `${this.config.CDFIR_WEB_PUBLIC_URL}/connectors?${query}`;
  }

  private async fetchProfile(
    providerName: Provider,
    accessToken: string,
  ): Promise<ProfileInfo | null> {
    const fetchFn: FetchLike = this.fetchImpl ?? ((url, init) => fetch(url, init));
    try {
      const url =
        providerName === Provider.microsoft
          ? `${this.config.CDFIR_MS_GRAPH_BASE_URL}/me`
          : `${this.config.CDFIR_GOOGLE_API_BASE_URL}/oauth2/v2/userinfo`;
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const json: unknown = await response.json();
      if (providerName === Provider.microsoft) {
        const parsed = graphProfileSchema.safeParse(json);
        if (!parsed.success) return null;
        const email = parsed.data.mail ?? parsed.data.userPrincipalName ?? '';
        return {
          externalId: parsed.data.id ?? 'me',
          email,
          displayName: parsed.data.displayName ?? email,
        };
      }
      const parsed = googleProfileSchema.safeParse(json);
      if (!parsed.success) return null;
      const email = parsed.data.email ?? '';
      return {
        externalId: parsed.data.id ?? 'me',
        email,
        displayName: parsed.data.name ?? email,
      };
    } catch {
      return null;
    }
  }

  private async storeRefreshToken(
    tx: TenantScopedTx,
    tenantId: string,
    connectorAccountId: string,
    refreshToken: string,
  ): Promise<void> {
    const encrypted = await encryptSecret(
      this.kek,
      tenantId,
      connectorSecretScope(connectorAccountId),
      Buffer.from(refreshToken, 'utf8'),
    );
    await tx.connectorSecret.deleteMany({
      where: { connectorAccountId, kind: SecretKind.oauth_refresh_token },
    });
    await tx.connectorSecret.create({
      data: {
        tenantId,
        connectorAccountId,
        kind: SecretKind.oauth_refresh_token,
        ...encryptedSecretColumns(encrypted),
      },
    });
  }

  /**
   * Complete the delegated OAuth flow. Returns the browser redirect target;
   * all failure modes redirect with an error marker (never leak details).
   */
  async completeCallback(
    providerName: Provider,
    query: Record<string, unknown>,
    cookies: Record<string, string | undefined>,
  ): Promise<{ redirectUrl: string }> {
    // Microsoft admin-consent returns here without a code; it is a pure
    // UX redirect (no tokens involved, nothing to verify or mutate).
    if (providerName === Provider.microsoft && typeof query.admin_consent === 'string') {
      return { redirectUrl: this.webRedirect('admin_consent=1') };
    }

    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    const flow = state.length > 0 ? openConnectorFlow(this.sealingKey, state) : null;
    if (!flow || flow.provider !== providerName) {
      throw new BadRequestException('connect flow missing or expired; restart the connection');
    }
    // Cookie binding: the callback must arrive in the browser that started it.
    if (cookies['cdfir_connectorflow'] !== state) {
      throw new BadRequestException('connect flow does not belong to this browser session');
    }
    if (code.length === 0) {
      await this.markError(flow, 'provider returned no authorization code');
      return { redirectUrl: this.webRedirect('connected=0&reason=denied') };
    }

    let tokens: ExchangedTokens;
    try {
      tokens =
        providerName === Provider.microsoft
          ? await exchangeMicrosoftAuthorizationCode({
              msLoginBaseUrl: this.config.CDFIR_MS_LOGIN_BASE_URL,
              clientId: this.config.CDFIR_MS_CLIENT_ID,
              clientSecret: this.config.CDFIR_MS_CLIENT_SECRET,
              code,
              redirectUri: this.redirectUriFor(Provider.microsoft),
              codeVerifier: flow.verifier,
              scopes: MICROSOFT_DELEGATED_SCOPES,
              fetchImpl: this.fetchImpl,
            })
          : await exchangeGoogleAuthorizationCode({
              googleOauthTokenUrl: this.config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
              clientId: this.config.CDFIR_GOOGLE_CLIENT_ID,
              clientSecret: this.config.CDFIR_GOOGLE_CLIENT_SECRET,
              code,
              redirectUri: this.redirectUriFor(Provider.google),
              fetchImpl: this.fetchImpl,
            });
    } catch {
      await this.markError(flow, 'authorization code exchange failed');
      return { redirectUrl: this.webRedirect('connected=0&reason=exchange_failed') };
    }

    if (tokens.refreshToken === undefined || tokens.refreshToken.length === 0) {
      await this.markError(flow, 'provider granted no refresh token');
      return { redirectUrl: this.webRedirect('connected=0&reason=no_refresh_token') };
    }
    const refreshToken = tokens.refreshToken;

    const profile = await this.fetchProfile(providerName, tokens.accessToken);
    const grantedScopes =
      tokens.scope !== undefined && tokens.scope.length > 0
        ? tokens.scope.split(' ').filter((s) => s.length > 0)
        : [
            ...(providerName === Provider.microsoft
              ? MICROSOFT_DELEGATED_SCOPES
              : GOOGLE_DELEGATED_SCOPES),
          ];

    await withTenantContext(this.prisma, flow.tenantId, async (tx) => {
      const account = await tx.connectorAccount.findFirst({
        where: { id: flow.connectorId, tenantId: flow.tenantId },
      });
      if (!account) throw new NotFoundException();

      await this.storeRefreshToken(tx, flow.tenantId, account.id, refreshToken);
      await tx.connectorScope.createMany({
        data: grantedScopes.map((scope) => ({
          tenantId: flow.tenantId,
          connectorAccountId: account.id,
          scope,
        })),
        skipDuplicates: true,
      });

      const externalIdentity =
        profile !== null && profile.email.length > 0 ? profile.email : 'connected account';
      await tx.connectorAccount.update({
        where: { id: account.id },
        data: { status: ConnectorStatus.connected, statusDetail: '', externalIdentity },
      });

      // Delegated mode collects only the signed-in identity: one custodian.
      const externalId = profile?.externalId ?? 'me';
      await tx.custodian.upsert({
        where: {
          connectorAccountId_externalId: { connectorAccountId: account.id, externalId },
        },
        create: {
          tenantId: flow.tenantId,
          connectorAccountId: account.id,
          externalId,
          email: profile?.email ?? externalIdentity,
          displayName: profile?.displayName ?? '',
        },
        update: {
          email: profile?.email ?? externalIdentity,
          displayName: profile?.displayName ?? '',
        },
      });

      await this.audit.appendTx(tx, {
        tenantId: flow.tenantId,
        actorUserId: flow.userId,
        action: 'connector.connected',
        targetType: 'connector_account',
        targetId: account.id,
        summary: { provider: providerName, mode: 'delegated', scopes: grantedScopes },
      });
    });

    return { redirectUrl: this.webRedirect('connected=1') };
  }

  private async markError(flow: ConnectorFlowPayload, detail: string): Promise<void> {
    await withTenantContext(this.prisma, flow.tenantId, (tx) =>
      tx.connectorAccount.updateMany({
        where: { id: flow.connectorId, tenantId: flow.tenantId },
        data: { status: ConnectorStatus.error, statusDetail: detail },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Organization-mode setup
  // -------------------------------------------------------------------------

  async configureOrg(
    auth: AuthContext,
    connectorId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ ok: true; adminConsentUrl?: string; auditScopes?: string[] }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const account = await tx.connectorAccount.findFirst({
        where: { id: connectorId, tenantId: auth.tenantId },
      });
      if (!account) throw new NotFoundException();
      if (account.mode !== 'organization') {
        throw new ConflictException(
          'organization setup applies only to organization-mode connectors',
        );
      }

      if (account.provider === Provider.microsoft) {
        if (this.config.CDFIR_MS_CLIENT_ID.length === 0) {
          throw new ConflictException(
            'provider OAuth is not configured: set CDFIR_MS_CLIENT_ID (and its client secret) to enable microsoft connections',
          );
        }
        const input = zodValidate(orgMicrosoftSetupRequest, body);
        await tx.connectorAccount.update({
          where: { id: account.id },
          data: {
            externalTenantId: input.externalTenantId,
            statusDetail: 'awaiting admin consent; run a connection test after consenting',
          },
        });
        // Record the audit app permissions expected on this org connector so
        // admin-consent guidance and later verification can reference them.
        await tx.connectorScope.createMany({
          data: MICROSOFT_AUDIT_ORG_APP_PERMISSIONS.map((scope) => ({
            tenantId: auth.tenantId,
            connectorAccountId: account.id,
            scope,
          })),
          skipDuplicates: true,
        });
        const adminConsentUrl = buildMicrosoftAdminConsentUrl({
          msLoginBaseUrl: this.config.CDFIR_MS_LOGIN_BASE_URL,
          tenantId: input.externalTenantId,
          clientId: this.config.CDFIR_MS_CLIENT_ID,
          redirectUri: this.redirectUriFor(Provider.microsoft),
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'connector.org_configured',
          targetType: 'connector_account',
          targetId: account.id,
          summary: {
            provider: 'microsoft',
            externalTenantId: input.externalTenantId,
            auditScopes: [...MICROSOFT_AUDIT_ORG_APP_PERMISSIONS],
          },
          request,
        });
        return {
          ok: true as const,
          adminConsentUrl,
          auditScopes: [...MICROSOFT_AUDIT_ORG_APP_PERMISSIONS],
        };
      }

      // Google: domain-wide delegation with an uploaded service-account key.
      const input = zodValidate(orgGoogleSetupRequest, body);
      const key = parseServiceAccountKey(input.serviceAccountJson);
      if (!key) {
        throw new BadRequestException(
          'serviceAccountJson must be a JSON service-account key containing client_email and private_key',
        );
      }
      const encrypted = await encryptSecret(
        this.kek,
        auth.tenantId,
        connectorSecretScope(account.id),
        Buffer.from(input.serviceAccountJson, 'utf8'),
      );
      await tx.connectorSecret.deleteMany({
        where: { connectorAccountId: account.id, kind: SecretKind.service_account_key },
      });
      await tx.connectorSecret.create({
        data: {
          tenantId: auth.tenantId,
          connectorAccountId: account.id,
          kind: SecretKind.service_account_key,
          ...encryptedSecretColumns(encrypted),
        },
      });
      await tx.connectorAccount.update({
        where: { id: account.id },
        data: {
          allowedDomains: input.allowedDomains,
          externalIdentity: input.adminEmail,
          status: ConnectorStatus.connected,
          statusDetail: '',
        },
      });
      // Record the audit DWD scopes expected on the domain-wide delegation grant
      // so setup guidance and verification can reference them.
      await tx.connectorScope.createMany({
        data: GOOGLE_AUDIT_DWD_SCOPES.map((scope) => ({
          tenantId: auth.tenantId,
          connectorAccountId: account.id,
          scope,
        })),
        skipDuplicates: true,
      });
      // Summary NEVER contains key material — only the delegation shape.
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'connector.org_configured',
        targetType: 'connector_account',
        targetId: account.id,
        summary: {
          provider: 'google',
          allowedDomains: input.allowedDomains,
          adminEmail: input.adminEmail,
          serviceAccountEmail: key.client_email,
          auditScopes: [...GOOGLE_AUDIT_DWD_SCOPES],
        },
        request,
      });
      return { ok: true as const, auditScopes: [...GOOGLE_AUDIT_DWD_SCOPES] };
    });
  }

  // -------------------------------------------------------------------------
  // Connection test
  // -------------------------------------------------------------------------

  private async loadAccountWithSecrets(auth: AuthContext, connectorId: string) {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const account = await tx.connectorAccount.findFirst({
        where: { id: connectorId, tenantId: auth.tenantId },
        include: { secrets: true },
      });
      if (!account) throw new NotFoundException();
      return account;
    });
  }

  private secretRecords(
    secrets: {
      id: string;
      kind: SecretKind;
      kekKeyId: string;
      wrappedDek: Uint8Array;
      dekIv: Uint8Array;
      dekTag: Uint8Array;
      ciphertext: Uint8Array;
      cipherIv: Uint8Array;
      cipherTag: Uint8Array;
    }[],
  ): ConnectorSecretRecord[] {
    return secrets.map((s) => ({
      id: s.id,
      kind: s.kind,
      kekKeyId: s.kekKeyId,
      wrappedDek: Buffer.from(s.wrappedDek),
      dekIv: Buffer.from(s.dekIv),
      dekTag: Buffer.from(s.dekTag),
      ciphertext: Buffer.from(s.ciphertext),
      cipherIv: Buffer.from(s.cipherIv),
      cipherTag: Buffer.from(s.cipherTag),
    }));
  }

  private async tokenProviderFor(
    account: Awaited<ReturnType<ConnectorsService['loadAccountWithSecrets']>>,
    impersonateEmail?: string,
  ) {
    if (account.provider === Provider.upload) {
      throw new ConflictException(
        'upload connectors have no provider tokens; uploaded files are processed locally',
      );
    }
    return buildConnectorTokenProvider({
      kek: this.kek,
      config: this.config,
      account: {
        id: account.id,
        tenantId: account.tenantId,
        provider: account.provider,
        mode: account.mode,
        externalIdentity: account.externalIdentity,
        externalTenantId: account.externalTenantId,
        allowedDomains: account.allowedDomains,
      },
      secrets: this.secretRecords(account.secrets),
      persistRotatedSecret: async (secretId, encrypted: EncryptedSecret) => {
        await withTenantContext(this.prisma, account.tenantId, (tx) =>
          tx.connectorSecret.update({
            where: { id: secretId },
            data: { ...encryptedSecretColumns(encrypted), rotatedAt: new Date() },
          }),
        );
      },
      impersonateEmail,
      fetchImpl: this.fetchImpl,
    });
  }

  private directoryFor(
    account: { provider: Provider },
    tokenProvider: Awaited<ReturnType<ConnectorsService['tokenProviderFor']>>,
  ): CustodianDirectory {
    return account.provider === Provider.microsoft
      ? new GraphCustodianDirectory({
          tokenProvider,
          graphBaseUrl: this.config.CDFIR_MS_GRAPH_BASE_URL,
          fetchImpl: this.fetchImpl,
        })
      : new GoogleCustodianDirectory({
          tokenProvider,
          googleApiBaseUrl: this.config.CDFIR_GOOGLE_API_BASE_URL,
          fetchImpl: this.fetchImpl,
        });
  }

  async test(
    auth: AuthContext,
    connectorId: string,
    request: FastifyRequest,
  ): Promise<{ ok: boolean; detail: string }> {
    const account = await this.loadAccountWithSecrets(auth, connectorId);
    if (account.status === ConnectorStatus.revoked) {
      throw new ConflictException('connector has been revoked');
    }

    let ok = false;
    let detail: string;
    if (account.provider === Provider.upload) {
      // Uploads have no provider side to test: never build provider clients.
      ok = true;
      detail = 'local uploads';
    } else {
      try {
        const tokenProvider = await this.tokenProviderFor(account);
        if (account.mode === 'delegated') {
          const mail =
            account.provider === Provider.microsoft
              ? new GraphEmailConnector({
                  tokenProvider,
                  graphBaseUrl: this.config.CDFIR_MS_GRAPH_BASE_URL,
                  mode: 'delegated',
                  fetchImpl: this.fetchImpl,
                })
              : new GmailConnector({
                  tokenProvider,
                  googleApiBaseUrl: this.config.CDFIR_GOOGLE_API_BASE_URL,
                  fetchImpl: this.fetchImpl,
                });
          const discovery = await mail.listMailFolders('me');
          ok = true;
          detail = `ok: ${discovery.folders.length} mail folders visible`;
        } else {
          const directory = this.directoryFor(account, tokenProvider);
          const page = await directory.listUsers({});
          ok = true;
          detail = `ok: directory reachable (${page.users.length} users on first page)`;
        }
      } catch (err) {
        // ConnectorError messages are sanitized by the connectors package.
        detail =
          err instanceof ConnectorError || err instanceof ConnectorCredentialsError
            ? err.message
            : 'provider call failed';
      }
    }

    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await tx.connectorAccount.update({
        where: { id: account.id },
        data: {
          status: ok ? ConnectorStatus.connected : ConnectorStatus.error,
          statusDetail: ok ? '' : detail,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'connector.tested',
        targetType: 'connector_account',
        targetId: account.id,
        summary: { ok, detail },
        request,
      });
    });

    return { ok, detail };
  }

  // -------------------------------------------------------------------------
  // Custodians
  // -------------------------------------------------------------------------

  async custodians(
    auth: AuthContext,
    connectorId: string,
    query: { search?: string; cursor?: string },
  ): Promise<{ items: CustodianDto[]; nextCursor: string | null; notice?: string }> {
    const account = await this.loadAccountWithSecrets(auth, connectorId);
    if (account.status === ConnectorStatus.revoked) {
      throw new ConflictException('connector has been revoked');
    }

    if (account.provider === Provider.upload) {
      // Upload custodians are declared at collection time (uploadCustodian);
      // there is no provider directory to enumerate.
      const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
        tx.custodian.findMany({
          where: { tenantId: auth.tenantId, connectorAccountId: account.id },
          orderBy: { id: 'asc' },
        }),
      );
      return {
        items: rows.map((c) => ({
          id: c.id,
          externalId: c.externalId,
          email: c.email,
          displayName: c.displayName,
        })),
        nextCursor: null,
        notice: TRUTHFULNESS_NOTICES.pstExtraction,
      };
    }

    if (account.mode === 'delegated') {
      // The connected identity is the ONLY selectable custodian — the UI
      // must not suggest that delegated access reaches other accounts.
      const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
        tx.custodian.findMany({
          where: { tenantId: auth.tenantId, connectorAccountId: account.id },
          orderBy: { id: 'asc' },
        }),
      );
      return {
        items: rows.map((c) => ({
          id: c.id,
          externalId: c.externalId,
          email: c.email,
          displayName: c.displayName,
        })),
        nextCursor: null,
        notice: TRUTHFULNESS_NOTICES.delegatedAccess,
      };
    }

    const tokenProvider = await this.tokenProviderFor(account);
    const directory = this.directoryFor(account, tokenProvider);
    const page = await directory.listUsers({
      search: query.search,
      cursor: query.cursor,
    });

    const items = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const upserted: CustodianDto[] = [];
      for (const user of page.users) {
        const row = await tx.custodian.upsert({
          where: {
            connectorAccountId_externalId: {
              connectorAccountId: account.id,
              externalId: user.externalId,
            },
          },
          create: {
            tenantId: auth.tenantId,
            connectorAccountId: account.id,
            externalId: user.externalId,
            email: user.email,
            displayName: user.displayName,
          },
          update: { email: user.email, displayName: user.displayName },
        });
        upserted.push({
          id: row.id,
          externalId: row.externalId,
          email: row.email,
          displayName: row.displayName,
        });
      }
      return upserted;
    });

    return { items, nextCursor: page.nextCursor ?? null };
  }

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  async revoke(
    auth: AuthContext,
    connectorId: string,
    request: FastifyRequest,
  ): Promise<{ ok: true; providerRevocationNote: string }> {
    const note = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const account = await tx.connectorAccount.findFirst({
        where: { id: connectorId, tenantId: auth.tenantId },
      });
      if (!account) throw new NotFoundException();
      const deleted = await tx.connectorSecret.deleteMany({
        where: { connectorAccountId: account.id },
      });
      await tx.connectorAccount.update({
        where: { id: account.id },
        data: {
          status: ConnectorStatus.revoked,
          statusDetail: 'revoked; stored tokens deleted',
          revokedAt: new Date(),
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'connector.revoked',
        targetType: 'connector_account',
        targetId: account.id,
        summary: { secretsDeleted: deleted.count },
        request,
      });
      return PROVIDER_REVOCATION_NOTES[account.provider];
    });
    return { ok: true, providerRevocationNote: note };
  }
}
