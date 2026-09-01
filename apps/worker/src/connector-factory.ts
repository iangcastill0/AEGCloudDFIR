import {
  buildImapClient,
  type DriveConnector,
  DropboxDelegatedTokenSource,
  DropboxDriveConnector,
  type EmailConnector,
  GmailConnector,
  GOOGLE_DWD_SCOPES,
  GOOGLE_REPORTS_APPLICATIONS,
  GOOGLE_REPORTS_AUDIT_SCOPE,
  GOOGLE_VAULT_READONLY_SCOPE,
  GoogleDelegatedTokenSource,
  GoogleDriveConnector,
  GoogleReportsConnector,
  GoogleServiceAccountTokenSource,
  GoogleVaultConnector,
  GraphAuditConnector,
  GraphDriveConnector,
  GraphEmailConnector,
  ImapConnectionPool,
  type ImapConnectorOptions,
  ImapEmailConnector,
  MICROSOFT_DELEGATED_SCOPES,
  MICROSOFT_GRAPH_AUDIT_APP_SCOPE,
  MICROSOFT_MANAGEMENT_ACTIVITY_APP_SCOPE,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  O365_MANAGEMENT_CONTENT_TYPES,
  O365ManagementActivityConnector,
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
  provider: 'microsoft' | 'google' | 'imap' | 'dropbox';
  mode: 'delegated' | 'organization';
  /**
   * Null for providers with no mailbox. Dropbox is files only, and the same
   * reasoning applies as for `drive` below: a stub that quietly returned no
   * messages would let a collection report that it looked at mail it can never
   * reach.
   */
  email: EmailConnector | null;
  /**
   * Null for providers with no file storage. IMAP is mail only, and handing back
   * a stub that throws would let a collection claim it looked at a drive it
   * cannot reach.
   */
  drive: DriveConnector | null;
  /**
   * Value to pass as the `custodian` argument of connector calls:
   * 'me' for delegated and all Google modes (DWD impersonates at the token
   * layer); the custodian externalId for Microsoft organization mode.
   */
  custodianRef: string;
}

/**
 * The drive client, or a clear error naming the provider that has none.
 *
 * A collection that selected drive on a mail-only connector must fail loudly.
 * Returning a stub that quietly yields nothing would report a complete
 * collection of a source we never looked at.
 */
/**
 * One IMAP connection pool per connector account, for the life of this worker
 * process.
 *
 * Every message is a separate BullMQ job, and each job builds its clients fresh.
 * Without a cache here the pool would be per job, which is the same as a login
 * per message — measured at 10,563 logins for one real mailbox, a pattern
 * providers treat as abuse. Keyed by connector account, so two custodians never
 * share a credential's connection.
 */
const imapPools = new Map<string, ImapConnectionPool>();

function imapPoolFor(
  connectorAccountId: string,
  settings: ImapConnectorOptions,
): ImapConnectionPool {
  const existing = imapPools.get(connectorAccountId);
  if (existing !== undefined) return existing;
  const pool = new ImapConnectionPool({
    createClient: () => buildImapClient(settings),
  });
  imapPools.set(connectorAccountId, pool);
  return pool;
}

/** Close every pooled IMAP connection. Called on worker shutdown. */
export async function closeImapPools(): Promise<void> {
  const pools = [...imapPools.values()];
  imapPools.clear();
  await Promise.all(pools.map((p) => p.closeAll()));
}

export function requireDrive(bundle: ConnectorBundle): DriveConnector {
  if (bundle.drive === null) {
    throw new Error(
      `${bundle.provider} connectors collect mail only; this collection selected drive, which they cannot reach`,
    );
  }
  return bundle.drive;
}

/**
 * The mail client, or a clear error naming the provider that has none.
 *
 * The mirror of requireDrive, and for the same reason: a collection that
 * selected mail on a files-only connector must fail loudly rather than report a
 * complete collection of a source that was never looked at.
 */
export function requireEmail(bundle: ConnectorBundle): EmailConnector {
  if (bundle.email === null) {
    throw new Error(
      `${bundle.provider} connectors collect files only; this collection selected mail, which they cannot reach`,
    );
  }
  return bundle.email;
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

  // IMAP has no OAuth: the connection is opened with a stored app password, and
  // the host and port live in the same encrypted blob because they are useless
  // apart. Handled before the token-provider branches, which have nothing to
  // give here.
  if (account.provider === 'imap') {
    const row = requireSecret(secrets, 'imap_password', 'IMAP credential');
    const plaintext = (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString(
      'utf8',
    );
    const settings = parseImapSettings(plaintext);
    if (settings === null) {
      throw new Error(
        `connector account ${connectorAccountId} has a stored IMAP credential that could not be read`,
      );
    }
    return {
      provider: 'imap',
      mode: 'delegated',
      // The pool is shared across every job for this connector, so a collection
      // logs in once rather than once per message.
      email: new ImapEmailConnector({
        ...settings,
        pool: imapPoolFor(connectorAccountId, settings),
      }),
      // A mailbox is not a drive, and pretending otherwise would make a
      // collection claim it looked somewhere it cannot reach.
      drive: null,
      // IMAP identifies the mailbox by its login name.
      custodianRef: settings.username,
    };
  }

  if (account.provider === 'dropbox') {
    const row = requireSecret(secrets, 'oauth_refresh_token', 'OAuth refresh token');
    const refreshToken = (await decryptSecretRow(ctx, tenantId, connectorAccountId, row)).toString(
      'utf8',
    );
    // Dropbox does not rotate refresh tokens, so there is nothing to persist
    // back: the stored secret stays valid until the custodian revokes the app.
    const dropboxToken = new DropboxDelegatedTokenSource({
      tokenEndpoint: ctx.config.CDFIR_DROPBOX_OAUTH_TOKEN_URL,
      clientId: ctx.config.CDFIR_DROPBOX_CLIENT_ID,
      clientSecret: ctx.config.CDFIR_DROPBOX_CLIENT_SECRET,
      refreshToken,
    });

    // Organization mode addresses one team member per collection via a header.
    // Refusing to guess is deliberate: a missing custodian would otherwise
    // collect whichever account the team token defaults to.
    let selectUserId: string | undefined;
    if (account.mode === 'organization') {
      if (args.custodian === undefined) {
        throw new Error('dropbox organization mode requires a custodian to address');
      }
      selectUserId = args.custodian.externalId;
    }

    return {
      provider: 'dropbox',
      mode: account.mode,
      // Dropbox has no mailbox. See the note on ConnectorBundle.email.
      email: null,
      drive: new DropboxDriveConnector({
        tokenProvider: dropboxToken,
        rpcBase: ctx.config.CDFIR_DROPBOX_API_BASE_URL,
        contentBase: ctx.config.CDFIR_DROPBOX_CONTENT_BASE_URL,
        ...(selectUserId === undefined ? {} : { selectUserId }),
        ...(args.onRateLimit === undefined ? {} : { onRateLimit: args.onRateLimit }),
      }),
      // Delegated collects as the signed-in account; organization addresses the
      // member through the header above, so the ref itself is never used to
      // choose an identity.
      custodianRef: selectUserId ?? 'me',
    };
  }

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

/**
 * Read the IMAP settings stored beside the app password.
 *
 * Returns null rather than throwing so the caller can say which connector is
 * broken; a bare JSON error here names nothing useful.
 */
function parseImapSettings(plaintext: string): ImapConnectorOptions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
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
