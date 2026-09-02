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
  ConnectionMode,
  ConnectorStatus,
  Provider,
  SecretKind,
  withTenantContext,
  decryptSecret,
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
  exchangeDropboxAuthorizationCode,
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
  createImapConnectorRequest,
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
  DROPBOX_DELEGATED_SCOPES,
  ImapEmailConnector,
  SLACK_USER_SCOPES,
  ProviderAuthError,
  buildDropboxAuthorizationUrl,
  buildSlackAuthorizationUrl,
  exchangeSlackAuthorizationCode,
  type ImapConnectorOptions,
  type SlackExchangedToken,
} from '@aeg-clouddfir/connectors';
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
  slack:
    'The stored user token was deleted. To revoke it on the provider side, the workspace owner removes the app under Slack settings > Manage apps, or the custodian revokes it from their own account. A Slack user token does not expire on its own, so until that happens it would still work if it were ever recovered from a backup.',
  dropbox:
    'Stored tokens were deleted. To revoke the grant on the provider side, the custodian removes the app under https://www.dropbox.com/account/connected_apps (a team admin does it from the admin console for organization connections). Until they do, the refresh token would still work if it were ever recovered from a backup.',
  imap: 'The stored app password was deleted. Revoke it at the mail provider too — for Yahoo, iCloud or Gmail that means deleting the app password in the account security settings, which is the only thing that stops it being used again.',
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

/**
 * Dropbox's /users/get_current_account. Its display name is nested under
 * `name`, unlike the flat shape the other two providers return.
 */
const dropboxProfileSchema = z.object({
  account_id: z.string().optional(),
  email: z.string().optional(),
  name: z.object({ display_name: z.string().optional() }).optional(),
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

  /**
   * List connectors, revoked ones excluded by default.
   *
   * A revoked connector is NOT deleted. `Collection` and `Custodian` reference
   * it without cascade, so the row is the record of which credential collected
   * which evidence; removing it would erase that link or fail on the foreign
   * key. Hiding it keeps the list clean and the provenance intact, and
   * `includeRevoked` brings it back when someone needs to look.
   */
  /**
   * Create an IMAP connector.
   *
   * Unlike OAuth providers there is no browser round trip: the operator supplies
   * a host and an app password, both are stored, and the connector is usable
   * immediately. The app password is envelope-encrypted like every other secret
   * and never appears in the audit summary — the chain is append-only and
   * exportable, so a secret written into it cannot be taken back out.
   *
   * The status starts as pending_auth. "Test" proves the credential works and
   * flips it to connected; claiming connected before anything has spoken to the
   * server would be a guess.
   */
  async createImap(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ connector: ConnectorDto }> {
    const input = zodValidate(createImapConnectorRequest, body);

    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
      if (!tenant) throw new NotFoundException();
      const used = await tx.connectorAccount.count({
        where: { tenantId: auth.tenantId, status: { not: ConnectorStatus.revoked } },
      });
      assertWithinQuota('maxConnectorAccounts', used, readQuota(tenant, 'maxConnectorAccounts'));

      // One mailbox, one connector. Four connectors to the same Yahoo mailbox
      // were created in eleven minutes because a response-parse bug made the
      // page look like it had failed, and nothing here said "you already have
      // this". A rotated app password is a legitimate reason to reconnect, so
      // the existing one has to be revoked first rather than silently replaced.
      const existing = await tx.connectorAccount.findFirst({
        where: {
          tenantId: auth.tenantId,
          provider: Provider.imap,
          externalIdentity: input.username,
          status: { not: ConnectorStatus.revoked },
        },
        select: { id: true, label: true },
      });
      if (existing !== null) {
        throw new ConflictException(
          `a connector for ${input.username} already exists ("${existing.label}"); revoke it before adding another`,
        );
      }

      const created = await tx.connectorAccount.create({
        data: {
          tenantId: auth.tenantId,
          provider: Provider.imap,
          // One credential reaches exactly one mailbox, which is what delegated
          // means everywhere else in this app.
          mode: ConnectionMode.delegated,
          label: input.label,
          // IMAP has no account id; the login name IS the identity.
          externalIdentity: input.username,
          status: ConnectorStatus.pending_auth,
          statusDetail: 'credential stored; run Test to confirm it works',
          createdById: auth.userId,
        },
      });

      // Host, port and TLS travel with the secret: they are useless apart, and
      // keeping them together means one decrypt gives the worker everything it
      // needs to open a connection.
      const encrypted = await encryptSecret(
        this.kek,
        auth.tenantId,
        connectorSecretScope(created.id),
        Buffer.from(
          JSON.stringify({
            host: input.host,
            port: input.port,
            secure: input.secure,
            username: input.username,
            password: input.appPassword,
          }),
          'utf8',
        ),
      );
      await tx.connectorSecret.create({
        data: {
          tenantId: auth.tenantId,
          connectorAccountId: created.id,
          kind: SecretKind.imap_password,
          ...encryptedSecretColumns(encrypted),
        },
      });

      // The one selectable custodian, created now rather than discovered later.
      // Delegated OAuth learns the identity from a profile call in its callback;
      // IMAP has no directory and no callback — the login name IS the identity.
      // Without this row the Custodians step has nothing to offer and sits on
      // "Resolving the connected identity..." forever.
      await tx.custodian.upsert({
        where: {
          connectorAccountId_externalId: {
            connectorAccountId: created.id,
            externalId: input.username,
          },
        },
        create: {
          tenantId: auth.tenantId,
          connectorAccountId: created.id,
          externalId: input.username,
          email: input.username,
          displayName: input.username,
        },
        update: { email: input.username },
      });

      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'connector.created',
        targetType: 'connector_account',
        targetId: created.id,
        // Where and who, never the credential.
        summary: {
          provider: 'imap',
          mode: 'delegated',
          label: input.label,
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
        },
        request,
      });
      return created;
    });

    return { connector: toDto(row) };
  }

  /**
   * Retire connect flows that were started and never finished.
   *
   * An abandoned OAuth flow leaves a connector with no identity and no
   * credential. The sealed state expires after CONNECT_FLOW_TTL_SECONDS, so it
   * can never complete — yet it stayed in the list forever and could still be
   * chosen in the collection wizard, where it fails at the first provider call.
   *
   * Marked revoked rather than deleted: the audit chain already records that
   * someone created it, and "revoked" is the honest state for something that can
   * no longer be used. The detail says which kind of dead it is. IMAP is
   * excluded — it is created pending_auth too, but that only means "not tested
   * yet", and it holds a credential from the moment it exists.
   */
  private async retireAbandonedFlows(auth: AuthContext): Promise<void> {
    // A grace period past the flow TTL: a slow sign-in should not be swept away
    // while the operator is still on the provider's page.
    const cutoff = new Date(Date.now() - CONNECT_FLOW_TTL_SECONDS * 2 * 1000);
    await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.connectorAccount.updateMany({
        where: {
          tenantId: auth.tenantId,
          provider: { in: [Provider.microsoft, Provider.google] },
          status: { in: [ConnectorStatus.pending_auth, ConnectorStatus.error] },
          // No identity means the provider never told us who this is, so the
          // flow never reached the callback.
          externalIdentity: '',
          createdAt: { lt: cutoff },
        },
        data: {
          status: ConnectorStatus.revoked,
          statusDetail: 'sign-in was never completed; the connect link expired',
        },
      }),
    );
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
    includeRevoked = false,
  ): Promise<{ items: ConnectorDto[]; nextCursor: string | null }> {
    // Before listing, so a dead flow never appears as something to choose.
    await this.retireAbandonedFlows(auth);

    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.connectorAccount.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(includeRevoked ? {} : { status: { not: ConnectorStatus.revoked } }),
        },
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
    // Must match the provider console character for character. A mismatch reads
    // as a provider fault ("redirect_uri did not match") and is always config.
    const paths: Partial<Record<Provider, string>> = {
      [Provider.microsoft]: this.config.CDFIR_MS_REDIRECT_PATH,
      [Provider.google]: this.config.CDFIR_GOOGLE_REDIRECT_PATH,
      [Provider.dropbox]: this.config.CDFIR_DROPBOX_REDIRECT_PATH,
      [Provider.slack]: this.config.CDFIR_SLACK_REDIRECT_PATH,
    };
    const path = paths[providerName] ?? this.config.CDFIR_GOOGLE_REDIRECT_PATH;
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

    // IMAP has no OAuth redirect to send anyone to. It takes a host and an app
    // password, so it has its own route; letting it through here would create a
    // connector with no credential and no way to reach the mailbox.
    if (input.provider === 'imap') {
      throw new BadRequestException(
        'imap connectors are created with their credential via POST /api/v1/connectors/imap',
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
    // Microsoft and Dropbox both use PKCE; Google's delegated flow does not.
    const usesPkce = input.provider === 'microsoft' || input.provider === 'dropbox';
    const verifier = usesPkce ? randomBytes(32).toString('base64url') : '';
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
    } else if (input.provider === 'slack') {
      // No PKCE: Slack's OAuth v2 does not offer it, so the sealed, cookie-bound
      // state value is what ties the callback to the browser that started it.
      authorizationUrl = buildSlackAuthorizationUrl({
        clientId: this.config.CDFIR_SLACK_CLIENT_ID,
        redirectUri: this.redirectUriFor(Provider.slack),
        userScopes: SLACK_USER_SCOPES,
        state,
      });
    } else if (input.provider === 'dropbox') {
      const codeChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
      authorizationUrl = buildDropboxAuthorizationUrl({
        clientId: this.config.CDFIR_DROPBOX_CLIENT_ID,
        redirectUri: this.redirectUriFor(Provider.dropbox),
        scopes: DROPBOX_DELEGATED_SCOPES,
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
      if (providerName === Provider.dropbox) {
        // Dropbox's account endpoint is POST with no body, not GET. A GET
        // returns 400 and the connector would land as "connected" with an empty
        // identity — the wrong-custodian failure this lookup exists to prevent.
        const response = await fetchFn(
          `${this.config.CDFIR_DROPBOX_API_BASE_URL}/users/get_current_account`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) return null;
        const parsed = dropboxProfileSchema.safeParse(await response.json());
        if (!parsed.success) return null;
        const email = parsed.data.email ?? '';
        return {
          externalId: parsed.data.account_id ?? 'me',
          email,
          displayName: parsed.data.name?.display_name ?? email,
        };
      }

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

  /**
   * Store the credential a completed grant produced.
   *
   * The kind is a parameter because Slack has no refresh grant: its user token
   * does not expire and IS the access token. Storing it under
   * oauth_refresh_token would make every reader try a refresh that Slack does
   * not offer.
   */
  private async storeGrantSecret(
    tx: TenantScopedTx,
    tenantId: string,
    connectorAccountId: string,
    kind: SecretKind,
    value: string,
  ): Promise<void> {
    const encrypted = await encryptSecret(
      this.kek,
      tenantId,
      connectorSecretScope(connectorAccountId),
      Buffer.from(value, 'utf8'),
    );
    await tx.connectorSecret.deleteMany({ where: { connectorAccountId, kind } });
    await tx.connectorSecret.create({
      data: {
        tenantId,
        connectorAccountId,
        kind,
        ...encryptedSecretColumns(encrypted),
      },
    });
  }

  /**
   * Finish a Slack grant.
   *
   * Separate from the shared path for one reason: Slack issues a user token
   * that does not expire and no refresh token at all. The shared flow rejects a
   * grant without a refresh token, which is right for every other provider and
   * wrong here.
   *
   * The identity is taken from the exchange rather than a separate profile
   * call. Slack cannot force an account chooser, so recording exactly which
   * workspace and user was connected is what replaces that guarantee — and it
   * is displayed, so a wrong custodian is visible immediately instead of after
   * a collection.
   */
  private async completeSlackCallback(
    flow: ConnectorFlowPayload,
    code: string,
    _cookies: Record<string, string | undefined>,
  ): Promise<{ redirectUrl: string }> {
    let granted: SlackExchangedToken;
    try {
      granted = await exchangeSlackAuthorizationCode({
        clientId: this.config.CDFIR_SLACK_CLIENT_ID,
        clientSecret: this.config.CDFIR_SLACK_CLIENT_SECRET,
        code,
        redirectUri: this.redirectUriFor(Provider.slack),
        fetchImpl: this.fetchImpl,
      });
    } catch {
      await this.markError(flow, 'authorization code exchange failed');
      return { redirectUrl: this.webRedirect('connected=0&reason=exchange_failed') };
    }

    // Both halves matter: the person and the workspace. "jane" alone does not
    // say whose Slack was connected when someone belongs to several.
    const externalIdentity =
      granted.teamName === '' ? granted.userId : `${granted.userId}@${granted.teamName}`;

    await withTenantContext(this.prisma, flow.tenantId, async (tx) => {
      const account = await tx.connectorAccount.update({
        where: { id: flow.connectorId },
        data: {
          status: ConnectorStatus.connected,
          statusDetail: '',
          externalIdentity,
          externalTenantId: granted.teamId,
        },
      });
      await this.storeGrantSecret(
        tx,
        flow.tenantId,
        account.id,
        SecretKind.oauth_access_token,
        granted.accessToken,
      );
      await tx.custodian.upsert({
        where: {
          connectorAccountId_externalId: {
            connectorAccountId: account.id,
            externalId: granted.userId,
          },
        },
        create: {
          tenantId: flow.tenantId,
          connectorAccountId: account.id,
          externalId: granted.userId,
          email: '',
          displayName: externalIdentity,
        },
        update: { displayName: externalIdentity },
      });
      await this.audit.appendTx(tx, {
        tenantId: flow.tenantId,
        actorUserId: flow.userId,
        actorDisplay: '',
        effectiveRoles: [],
        action: 'connector.connected',
        targetType: 'connector',
        targetId: account.id,
        summary: {
          provider: 'slack',
          mode: 'delegated',
          externalIdentity,
          teamId: granted.teamId,
          grantedScopes: granted.scopes,
        },
      });
    });

    return { redirectUrl: this.webRedirect('connected=1') };
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

    // Slack's grant has no refresh token: the user token does not expire, and
    // there is no refresh grant unless the app opts into rotation. Handled here
    // rather than threaded through the shared path, where every reader would
    // then have to know that one provider's "refresh token" is not one.
    if (providerName === Provider.slack) {
      return this.completeSlackCallback(flow, code, cookies);
    }

    let tokens: ExchangedTokens;
    try {
      tokens =
        providerName === Provider.dropbox
          ? await exchangeDropboxAuthorizationCode({
              tokenEndpoint: this.config.CDFIR_DROPBOX_OAUTH_TOKEN_URL,
              clientId: this.config.CDFIR_DROPBOX_CLIENT_ID,
              clientSecret: this.config.CDFIR_DROPBOX_CLIENT_SECRET,
              code,
              redirectUri: this.redirectUriFor(Provider.dropbox),
              codeVerifier: flow.verifier,
              fetchImpl: this.fetchImpl,
            })
          : providerName === Provider.microsoft
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
              : providerName === Provider.dropbox
                ? DROPBOX_DELEGATED_SCOPES
                : GOOGLE_DELEGATED_SCOPES),
          ];

    await withTenantContext(this.prisma, flow.tenantId, async (tx) => {
      const account = await tx.connectorAccount.findFirst({
        where: { id: flow.connectorId, tenantId: flow.tenantId },
      });
      if (!account) throw new NotFoundException();

      await this.storeGrantSecret(
        tx,
        flow.tenantId,
        account.id,
        SecretKind.oauth_refresh_token,
        refreshToken,
      );
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

  /**
   * Recover the IMAP host, port and app password from the stored secret.
   *
   * Host and port live inside the encrypted blob alongside the password because
   * they are useless apart, and one decrypt then gives everything needed to open
   * a connection. Returns null when the connector has no such secret, which is a
   * connector that was never finished rather than an error.
   */
  private async imapSettings(account: {
    id: string;
    tenantId: string;
    secrets: { kind: SecretKind }[];
  }): Promise<ImapConnectorOptions | null> {
    const record = (account.secrets as ConnectorSecretRecord[]).find(
      (secret) => secret.kind === SecretKind.imap_password,
    );
    if (record === undefined) return null;
    const plaintext = await decryptSecret(
      this.kek,
      account.tenantId,
      connectorSecretScope(account.id),
      record,
    );
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const data = parsed as Record<string, unknown>;
    if (
      typeof data['host'] !== 'string' ||
      typeof data['port'] !== 'number' ||
      typeof data['secure'] !== 'boolean' ||
      typeof data['username'] !== 'string' ||
      typeof data['password'] !== 'string'
    ) {
      return null;
    }
    return {
      host: data['host'],
      port: data['port'],
      secure: data['secure'],
      username: data['username'],
      password: data['password'],
    };
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
    // IMAP authenticates with a stored app password on every connection, so
    // there is no OAuth token provider to build. The worker reads the secret
    // directly when it opens a connection.
    if (account.provider === Provider.imap) {
      throw new ConflictException(
        'imap connectors authenticate with a stored app password, not an OAuth token',
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
    } else if (account.provider === Provider.imap) {
      // A real connection and a real LIST. Anything less would report "ok" for a
      // credential that has never spoken to the server.
      const settings = await this.imapSettings(account);
      if (settings === null) {
        ok = false;
        detail = 'no stored IMAP credential; recreate the connector';
      } else {
        try {
          const discovery = await new ImapEmailConnector(settings).listMailFolders();
          ok = true;
          detail = `ok: ${String(discovery.folders.length)} mailboxes visible`;
        } catch (err) {
          ok = false;
          // ProviderAuthError already names the host and login and never the
          // password; anything else is not safe to echo back.
          detail =
            err instanceof ConnectorError || err instanceof ProviderAuthError
              ? err.message
              : 'IMAP connection failed';
        }
      }
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
      const rows = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        const existing = await tx.custodian.findMany({
          where: { tenantId: auth.tenantId, connectorAccountId: account.id },
          orderBy: { id: 'asc' },
        });
        if (existing.length > 0) return existing;

        // An IMAP connector created before the custodian row was written has
        // nothing to select, and the wizard waits on it indefinitely. The
        // identity is known — it is the login — so fill it in rather than
        // leaving the operator stuck.
        if (account.provider !== Provider.imap || account.externalIdentity === '') return existing;
        const healed = await tx.custodian.upsert({
          where: {
            connectorAccountId_externalId: {
              connectorAccountId: account.id,
              externalId: account.externalIdentity,
            },
          },
          create: {
            tenantId: auth.tenantId,
            connectorAccountId: account.id,
            externalId: account.externalIdentity,
            email: account.externalIdentity,
            displayName: account.externalIdentity,
          },
          update: {},
        });
        return [healed];
      });
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
