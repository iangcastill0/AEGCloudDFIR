import {
  GmailConnector,
  GoogleDelegatedTokenSource,
  GoogleDriveConnector,
  GoogleServiceAccountTokenSource,
  GraphDriveConnector,
  GraphEmailConnector,
  GOOGLE_DWD_SCOPES,
  MICROSOFT_DELEGATED_SCOPES,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  type DriveConnector,
  type EmailConnector,
  type RateLimitObserver,
  type TokenProvider,
} from '@evidencevault/connectors';
import { decryptSecret, encryptSecret, withTenantContext } from '@evidencevault/database';
import type { WorkerContext } from './context.js';
import { incrementProgress } from './progress.js';

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
        msLoginBaseUrl: ctx.config.EV_MS_LOGIN_BASE_URL,
        clientId: ctx.config.EV_MS_CLIENT_ID,
        clientSecret: ctx.config.EV_MS_CLIENT_SECRET,
        refreshToken,
        scopes: MICROSOFT_DELEGATED_SCOPES,
        onTokensRotated: makeRotationPersister(ctx, tenantId, connectorAccountId, row.id),
      });
    } else {
      if (account.externalTenantId === '') {
        throw new Error('microsoft organization mode requires the connector externalTenantId');
      }
      tokenProvider = new MicrosoftAppTokenSource({
        msLoginBaseUrl: ctx.config.EV_MS_LOGIN_BASE_URL,
        tenantId: account.externalTenantId,
        clientId: ctx.config.EV_MS_CLIENT_ID,
        clientSecret: ctx.config.EV_MS_CLIENT_SECRET,
      });
      if (args.custodian === undefined) {
        throw new Error('microsoft organization mode requires a custodian to address');
      }
      custodianRef = args.custodian.externalId;
    }
    const options = {
      tokenProvider,
      graphBaseUrl: ctx.config.EV_MS_GRAPH_BASE_URL,
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
      googleOauthTokenUrl: ctx.config.EV_GOOGLE_OAUTH_TOKEN_URL,
      clientId: ctx.config.EV_GOOGLE_CLIENT_ID,
      clientSecret: ctx.config.EV_GOOGLE_CLIENT_SECRET,
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
      googleOauthTokenUrl: ctx.config.EV_GOOGLE_OAUTH_TOKEN_URL,
      serviceAccountJson: serviceAccountShape(keyJson),
      scopes: GOOGLE_DWD_SCOPES,
      impersonateEmail: args.custodian.email,
      allowedDomains: account.allowedDomains,
    });
  }
  const options = {
    tokenProvider,
    googleApiBaseUrl: ctx.config.EV_GOOGLE_API_BASE_URL,
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
  source: 'email' | 'drive',
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
