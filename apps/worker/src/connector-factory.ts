import {
  GmailConnector,
  GoogleDelegatedTokenSource,
  GoogleDriveConnector,
  GoogleReportsConnector,
  GoogleServiceAccountTokenSource,
  GoogleVaultConnector,
  GraphAuditConnector,
  GraphDriveConnector,
  GraphEmailConnector,
  GOOGLE_DWD_SCOPES,
  GOOGLE_REPORTS_APPLICATIONS,
  GOOGLE_REPORTS_AUDIT_SCOPE,
  GOOGLE_VAULT_READONLY_SCOPE,
  MICROSOFT_DELEGATED_SCOPES,
  MICROSOFT_GRAPH_AUDIT_APP_SCOPE,
  MICROSOFT_MANAGEMENT_ACTIVITY_APP_SCOPE,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  O365_MANAGEMENT_CONTENT_TYPES,
  O365ManagementActivityConnector,
  type DriveConnector,
  type EmailConnector,
  type RateLimitObserver,
  type TokenProvider,
} from '@aeg-clouddfir/connectors';
import { decryptSecret, encryptSecret, withTenantContext } from '@aeg-clouddfir/database';
import type { CollectionScope } from '@aeg-clouddfir/contracts';
import type { WorkerContext } from './context.js';
import { incrementProgress } from './progress.js';
import {
  AuditRequiresOrganizationModeError,
  type AuditConnectorBundle,
  type TaggedAuditConnector,
} from './audit.js';

/**
 * SECRET SCOPE CONVENTION (shared with apps/api, which encrypts on the OAuth
 * callback): connector secret ciphertexts are AAD-bound to
 * `connector:<connectorAccountId>`. This factory is the source of truth for
 * that convention.
 */
export function connectorSecretScope(connectorAccountId: string): string {
  return `connector:${connectorAccountId}`;
}

export interface ConnectorBundle {
  provider: 'microsoft' | 'google';
  mode: 'delegated' | 'organization';
  email: EmailConnector;
  drive: DriveConnector;
  /**
   * Value to pass as the `custodian` argument of connector calls:
   * 'me' for delegated and all Google modes (DWD impersonates at the token
   * layer); the custodian externalId for Microsoft organization mode.
   */
  custodianRef: string;
}

export interface BuildConnectorsArgs {
  tenantId: string;
  connectorAccountId: string;
  /** Required for organization mode (Graph /users addressing, Google DWD impersonation). */
  custodian?: { externalId: string; email: string };
  onRateLimit?: RateLimitObserver;
}

interface SecretRow {
  id: string;
  kind: string;
  kekKeyId: string;
  wrappedDek: Uint8Array;
  dekIv: Uint8Array;
  dekTag: Uint8Array;
  ciphertext: Uint8Array;
  cipherIv: Uint8Array;
  cipherTag: Uint8Array;
}

async function decryptSecretRow(
  ctx: WorkerContext,
  tenantId: string,
  connectorAccountId: string,
  row: SecretRow,
): Promise<Buffer> {
  return decryptSecret(ctx.kek, tenantId, connectorSecretScope(connectorAccountId), {
    kekKeyId: row.kekKeyId,
    wrappedDek: Buffer.from(row.wrappedDek),
    dekIv: Buffer.from(row.dekIv),
    dekTag: Buffer.from(row.dekTag),
    ciphertext: Buffer.from(row.ciphertext),
    cipherIv: Buffer.from(row.cipherIv),
    cipherTag: Buffer.from(row.cipherTag),
  });
}

function requireSecret(secrets: SecretRow[], kind: string, label: string): SecretRow {
  const row = secrets.find((s) => s.kind === kind);
  if (row === undefined) {
    throw new Error(`connector account is missing its ${label} secret (kind=${kind})`);
  }
  return row;
}

/** Persist a provider-rotated refresh token, re-encrypted under the active KEK. */
function makeRotationPersister(
  ctx: WorkerContext,
  tenantId: string,
  connectorAccountId: string,
  secretRowId: string,
): (newRefreshToken: string) => Promise<void> {
  return async (newRefreshToken: string) => {
    const encrypted = await encryptSecret(
      ctx.kek,
      tenantId,
      connectorSecretScope(connectorAccountId),
      Buffer.from(newRefreshToken, 'utf8'),
    );
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.connectorSecret.update({
        where: { id: secretRowId },
        data: {
          kekKeyId: encrypted.kekKeyId,
          wrappedDek: new Uint8Array(encrypted.wrappedDek),
          dekIv: new Uint8Array(encrypted.dekIv),
          dekTag: new Uint8Array(encrypted.dekTag),
          ciphertext: new Uint8Array(encrypted.ciphertext),
          cipherIv: new Uint8Array(encrypted.cipherIv),
          cipherTag: new Uint8Array(encrypted.cipherTag),
          rotatedAt: new Date(),
        },
      });
    });
  };
}

const serviceAccountShape = (value: unknown): { client_email: string; private_key: string } => {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['client_email'] === 'string' &&
    typeof (value as Record<string, unknown>)['private_key'] === 'string'
  ) {
    const v = value as { client_email: string; private_key: string };
    return { client_email: v.client_email, private_key: v.private_key };
  }
  throw new Error('service account secret is not a valid service-account JSON key');
};

/**
 * Resolve Microsoft client credentials for organization (app-permission) mode.
 * Production always uses the configured app registration (CDFIR_MS_CLIENT_ID /
 * CDFIR_MS_CLIENT_SECRET). DEMO-ONLY FALLBACK: when no app registration is
 * configured AND the account carries a stored per-connector client_secret
 * (only scripts/demo-seed.ts writes one), that secret is decrypted and used
 * with the fixed client id 'demo-client' so the fake provider's
 * client-credentials flow works without real credentials.
 */
async function resolveMicrosoftAppCredentials(
  ctx: WorkerContext,
  tenantId: string,
  connectorAccountId: string,
  secrets: SecretRow[],
): Promise<{ clientId: string; clientSecret: string }> {
  if (ctx.config.CDFIR_MS_CLIENT_ID !== '') {
    return {
      clientId: ctx.config.CDFIR_MS_CLIENT_ID,
      clientSecret: ctx.config.CDFIR_MS_CLIENT_SECRET,
    };
  }
  const row = secrets.find((s) => s.kind === 'client_secret');
  if (row === undefined) {
    return {
      clientId: ctx.config.CDFIR_MS_CLIENT_ID,
      clientSecret: ctx.config.CDFIR_MS_CLIENT_SECRET,
    };
  }
  const clientSecret = (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString(
    'utf8',
  );
  return { clientId: 'demo-client', clientSecret };
}

/**
 * Build provider connectors for a connector account, decrypting stored
 * secrets and wiring the correct TokenProvider for the provider/mode pair.
 * Base URLs come from config so the demo fake-provider server works.
 */
export async function buildConnectorsForAccount(
  ctx: WorkerContext,
  args: BuildConnectorsArgs,
): Promise<ConnectorBundle> {
  const { tenantId, connectorAccountId } = args;
  const account = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      include: { secrets: true },
    }),
  );
  if (account === null) {
    throw new Error(`connector account ${connectorAccountId} not found`);
  }

  if (account.provider === 'upload') {
    throw new Error(
      'upload connector accounts have no provider clients; uploaded containers are processed locally',
    );
  }

  const secrets = account.secrets as unknown as SecretRow[];
  let tokenProvider: TokenProvider;
  let custodianRef = 'me';

  if (account.provider === 'microsoft') {
    if (account.mode === 'delegated') {
      const row = requireSecret(secrets, 'oauth_refresh_token', 'OAuth refresh token');
      const refreshToken = (
        await decryptSecretRow(ctx, tenantId, connectorAccountId, row)
      ).toString('utf8');
      tokenProvider = new MicrosoftDelegatedTokenSource({
        msLoginBaseUrl: ctx.config.CDFIR_MS_LOGIN_BASE_URL,
        clientId: ctx.config.CDFIR_MS_CLIENT_ID,
        clientSecret: ctx.config.CDFIR_MS_CLIENT_SECRET,
        refreshToken,
        scopes: MICROSOFT_DELEGATED_SCOPES,
        onTokensRotated: makeRotationPersister(ctx, tenantId, connectorAccountId, row.id),
      });
    } else {
      if (account.externalTenantId === '') {
        throw new Error('microsoft organization mode requires the connector externalTenantId');
      }
      const credentials = await resolveMicrosoftAppCredentials(
        ctx,
        tenantId,
        connectorAccountId,
        secrets,
      );
      tokenProvider = new MicrosoftAppTokenSource({
        msLoginBaseUrl: ctx.config.CDFIR_MS_LOGIN_BASE_URL,
        tenantId: account.externalTenantId,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      });
      if (args.custodian === undefined) {
        throw new Error('microsoft organization mode requires a custodian to address');
      }
      custodianRef = args.custodian.externalId;
    }
    const options = {
      tokenProvider,
      graphBaseUrl: ctx.config.CDFIR_MS_GRAPH_BASE_URL,
      mode: account.mode,
      onRateLimit: args.onRateLimit,
    };
    return {
      provider: 'microsoft',
      mode: account.mode,
      email: new GraphEmailConnector(options),
      drive: new GraphDriveConnector(options),
      custodianRef,
    };
  }

  // Google
  if (account.mode === 'delegated') {
    const row = requireSecret(secrets, 'oauth_refresh_token', 'OAuth refresh token');
    const refreshToken = (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString(
      'utf8',
    );
    tokenProvider = new GoogleDelegatedTokenSource({
      googleOauthTokenUrl: ctx.config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
      clientId: ctx.config.CDFIR_GOOGLE_CLIENT_ID,
      clientSecret: ctx.config.CDFIR_GOOGLE_CLIENT_SECRET,
      refreshToken,
    });
  } else {
    if (args.custodian === undefined) {
      throw new Error('google organization mode requires a custodian to impersonate');
    }
    const row = requireSecret(secrets, 'service_account_key', 'service account key');
    const keyJson = JSON.parse(
      (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString('utf8'),
    ) as unknown;
    tokenProvider = new GoogleServiceAccountTokenSource({
      googleOauthTokenUrl: ctx.config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
      serviceAccountJson: serviceAccountShape(keyJson),
      scopes: GOOGLE_DWD_SCOPES,
      impersonateEmail: args.custodian.email,
      allowedDomains: account.allowedDomains,
    });
  }
  const options = {
    tokenProvider,
    googleApiBaseUrl: ctx.config.CDFIR_GOOGLE_API_BASE_URL,
    onRateLimit: args.onRateLimit,
  };
  return {
    provider: 'google',
    mode: account.mode,
    email: new GmailConnector(options),
    drive: new GoogleDriveConnector(options),
    custodianRef,
  };
}

export interface BuildAuditConnectorsArgs extends BuildConnectorsArgs {
  /** Audit scope selection from the collection (content types, apps, matters). */
  auditScope?: CollectionScope['audit'];
}

/**
 * Build the org-scoped audit connectors for a connector account. Audit logs
 * are tenant/organization-wide (app permission / domain-wide delegation), never
 * per-custodian: a delegated-only connector cannot collect audit logs and
 * raises AuditRequiresOrganizationModeError so the caller records it as a
 * permission exception.
 *
 * Microsoft (organization): a MicrosoftAppTokenSource for the manage.office.com
 *   app scope -> O365ManagementActivityConnector (unified audit content types),
 *   plus a SEPARATE MicrosoftAppTokenSource for the Graph audit app scope ->
 *   GraphAuditConnector (directory audits / sign-ins).
 * Google (organization): a GoogleServiceAccountTokenSource impersonating the
 *   configured admin email, one per source with its least-privilege scope ->
 *   GoogleReportsConnector + GoogleVaultConnector.
 *
 * Base URLs are left at the connectors' production defaults (manage.office.com,
 * admin.googleapis.com, vault.googleapis.com); only the Graph audit connector
 * takes the configurable Graph base URL.
 */
export async function buildAuditConnectors(
  ctx: WorkerContext,
  args: BuildAuditConnectorsArgs,
): Promise<AuditConnectorBundle> {
  const { tenantId, connectorAccountId } = args;
  const account = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      include: { secrets: true },
    }),
  );
  if (account === null) {
    throw new Error(`connector account ${connectorAccountId} not found`);
  }
  if (account.mode !== 'organization') {
    throw new AuditRequiresOrganizationModeError(
      'audit log collection requires an organization-mode connector (app permission / domain-wide delegation); delegated connectors cannot collect audit logs',
    );
  }

  const secrets = account.secrets as unknown as SecretRow[];
  const auditScope = args.auditScope;
  const connectors: TaggedAuditConnector[] = [];

  if (account.provider === 'upload') {
    throw new Error('upload connector accounts cannot collect audit logs');
  }

  if (account.provider === 'microsoft') {
    if (account.externalTenantId === '') {
      throw new Error('microsoft organization mode requires the connector externalTenantId');
    }
    const credentials = await resolveMicrosoftAppCredentials(
      ctx,
      tenantId,
      connectorAccountId,
      secrets,
    );
    const appToken = (scope: string): MicrosoftAppTokenSource =>
      new MicrosoftAppTokenSource({
        msLoginBaseUrl: ctx.config.CDFIR_MS_LOGIN_BASE_URL,
        tenantId: account.externalTenantId,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scope,
      });

    const contentTypes = auditScope?.microsoft?.managementContentTypes ?? [];
    if (contentTypes.length > 0) {
      connectors.push({
        kind: 'o365_management_activity',
        connector: new O365ManagementActivityConnector({
          tokenProvider: appToken(MICROSOFT_MANAGEMENT_ACTIVITY_APP_SCOPE),
          tenantId: account.externalTenantId,
          contentTypes: contentTypes.length > 0 ? contentTypes : O365_MANAGEMENT_CONTENT_TYPES,
          onRateLimit: args.onRateLimit,
        }),
      });
    }

    const graphScopes: ('directoryAudits' | 'signIns')[] = [];
    if (auditScope?.microsoft?.includeGraphDirectoryAudits === true)
      graphScopes.push('directoryAudits');
    if (auditScope?.microsoft?.includeGraphSignins === true) graphScopes.push('signIns');
    if (graphScopes.length > 0) {
      connectors.push({
        kind: 'graph_audit',
        connector: new GraphAuditConnector({
          tokenProvider: appToken(MICROSOFT_GRAPH_AUDIT_APP_SCOPE),
          graphBaseUrl: ctx.config.CDFIR_MS_GRAPH_BASE_URL,
          scopes: graphScopes,
          onRateLimit: args.onRateLimit,
        }),
      });
    }

    if (connectors.length === 0) {
      throw new Error('audit collection includes no Microsoft audit sources');
    }
    return { provider: 'microsoft', mode: 'organization', connectors };
  }

  // Google organization: impersonate the configured admin, per-source scope.
  const row = requireSecret(secrets, 'service_account_key', 'service account key');
  const keyJson = JSON.parse(
    (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString('utf8'),
  ) as unknown;
  const serviceAccountJson = serviceAccountShape(keyJson);
  const dwdToken = (scope: string): GoogleServiceAccountTokenSource =>
    new GoogleServiceAccountTokenSource({
      googleOauthTokenUrl: ctx.config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
      serviceAccountJson,
      scopes: [scope],
      impersonateEmail: account.externalIdentity,
      allowedDomains: account.allowedDomains,
    });

  const applications = auditScope?.google?.reportApplications ?? [];
  if (applications.length > 0) {
    connectors.push({
      kind: 'google_reports',
      connector: new GoogleReportsConnector({
        tokenProvider: dwdToken(GOOGLE_REPORTS_AUDIT_SCOPE),
        applications: applications.length > 0 ? applications : GOOGLE_REPORTS_APPLICATIONS,
        onRateLimit: args.onRateLimit,
      }),
    });
  }

  if (auditScope?.google?.includeVault === true) {
    const matterIds = auditScope.google.vaultMatterIds ?? [];
    connectors.push({
      kind: 'google_vault',
      connector: new GoogleVaultConnector({
        tokenProvider: dwdToken(GOOGLE_VAULT_READONLY_SCOPE),
        ...(matterIds.length > 0 ? { vaultMatterIds: matterIds } : {}),
        onRateLimit: args.onRateLimit,
      }),
    });
  }

  if (connectors.length === 0) {
    throw new Error('audit collection includes no Google audit sources');
  }
  return { provider: 'google', mode: 'organization', connectors };
}

/**
 * Rate-limit observer that accumulates provider throttling wait time into the
 * custodian's progress counters. Fire-and-forget: bookkeeping failures never
 * break a collection.
 */
export function makeRateLimitObserver(
  ctx: WorkerContext,
  tenantId: string,
  collectionId: string,
  custodianId: string,
  source: 'email' | 'drive' | 'audit',
): RateLimitObserver {
  return (info) => {
    void withTenantContext(ctx.prisma, tenantId, (tx) =>
      incrementProgress(tx, collectionId, custodianId, source, {
        rateLimitWaitMs: info.waitMs,
        retries: 1,
      }),
    ).catch(() => undefined);
  };
}
