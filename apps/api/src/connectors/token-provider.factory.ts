import type { AppConfig } from '@aeg-clouddfir/config';
import {
  decryptSecret,
  encryptSecret,
  SecretKind,
  type EncryptedSecret,
  type KeyEncryptionProvider,
} from '@aeg-clouddfir/database';
import {
  DropboxDelegatedTokenSource,
  GOOGLE_DWD_SCOPES,
  GoogleDelegatedTokenSource,
  GoogleServiceAccountTokenSource,
  MICROSOFT_DELEGATED_SCOPES,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  type FetchLike,
  type TokenProvider,
} from '@aeg-clouddfir/connectors';

/**
 * TokenProvider construction from stored connector state. The worker mirrors
 * this factory: everything it needs is passed in explicitly (no Nest DI).
 * Secrets are decrypted in memory only and never logged.
 */

/**
 * AAD scope binding a ConnectorSecret ciphertext to its account.
 * SHARED CONVENTION with apps/worker/src/connector-factory.ts (the source of
 * truth): `connector:<connectorAccountId>` — never include the secret kind.
 */
export function connectorSecretScope(connectorAccountId: string): string {
  return `connector:${connectorAccountId}`;
}

export type ConnectorOauthConfig = Pick<
  AppConfig,
  | 'CDFIR_MS_LOGIN_BASE_URL'
  | 'CDFIR_MS_CLIENT_ID'
  | 'CDFIR_MS_CLIENT_SECRET'
  | 'CDFIR_GOOGLE_OAUTH_TOKEN_URL'
  | 'CDFIR_GOOGLE_CLIENT_ID'
  | 'CDFIR_GOOGLE_CLIENT_SECRET'
  | 'CDFIR_DROPBOX_OAUTH_TOKEN_URL'
  | 'CDFIR_DROPBOX_CLIENT_ID'
  | 'CDFIR_DROPBOX_CLIENT_SECRET'
>;

export interface ConnectorSecretRecord extends EncryptedSecret {
  id: string;
  kind: SecretKind;
}

export interface ConnectorAccountRecord {
  id: string;
  tenantId: string;
  provider: 'microsoft' | 'google' | 'dropbox';
  mode: 'delegated' | 'organization';
  externalIdentity: string;
  externalTenantId: string;
  allowedDomains: string[];
}

export class ConnectorCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCredentialsError';
  }
}

export interface BuildTokenProviderInput {
  kek: KeyEncryptionProvider;
  config: ConnectorOauthConfig;
  account: ConnectorAccountRecord;
  secrets: ConnectorSecretRecord[];
  /** Persist a rotated refresh token, re-encrypted, onto its secret row. */
  persistRotatedSecret: (secretId: string, encrypted: EncryptedSecret) => Promise<void>;
  /** Google organization mode: custodian to impersonate (defaults to the stored admin). */
  impersonateEmail?: string;
  fetchImpl?: FetchLike;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Parse a service-account key, accepting only the fields we need. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.client_email !== 'string' || record.client_email.length === 0) return null;
    if (typeof record.private_key !== 'string' || record.private_key.length === 0) return null;
    return { client_email: record.client_email, private_key: record.private_key };
  } catch {
    return null;
  }
}

function findSecret(
  secrets: ConnectorSecretRecord[],
  kind: SecretKind,
): ConnectorSecretRecord | undefined {
  return secrets.find((s) => s.kind === kind);
}

/** Build the TokenProvider matching the account's provider + mode. */
export async function buildConnectorTokenProvider(
  input: BuildTokenProviderInput,
): Promise<TokenProvider> {
  const { account, config, kek, secrets } = input;

  if (account.mode === 'delegated') {
    const row = findSecret(secrets, SecretKind.oauth_refresh_token);
    if (!row) throw new ConnectorCredentialsError('no stored refresh token for this connector');
    const scope = connectorSecretScope(account.id);
    const refreshToken = (await decryptSecret(kek, account.tenantId, scope, row)).toString('utf8');

    if (account.provider === 'microsoft') {
      return new MicrosoftDelegatedTokenSource({
        msLoginBaseUrl: config.CDFIR_MS_LOGIN_BASE_URL,
        clientId: config.CDFIR_MS_CLIENT_ID,
        clientSecret: config.CDFIR_MS_CLIENT_SECRET,
        refreshToken,
        scopes: MICROSOFT_DELEGATED_SCOPES,
        onTokensRotated: async (newRefreshToken) => {
          const encrypted = await encryptSecret(
            kek,
            account.tenantId,
            scope,
            Buffer.from(newRefreshToken, 'utf8'),
          );
          await input.persistRotatedSecret(row.id, encrypted);
        },
        fetchImpl: input.fetchImpl,
      });
    }
    if (account.provider === 'dropbox') {
      // Dropbox does not rotate the refresh token, so there is no
      // onTokensRotated callback to persist: the stored secret stays valid until
      // the custodian revokes the app.
      return new DropboxDelegatedTokenSource({
        tokenEndpoint: config.CDFIR_DROPBOX_OAUTH_TOKEN_URL,
        clientId: config.CDFIR_DROPBOX_CLIENT_ID,
        clientSecret: config.CDFIR_DROPBOX_CLIENT_SECRET,
        refreshToken,
        fetchImpl: input.fetchImpl,
      });
    }

    return new GoogleDelegatedTokenSource({
      googleOauthTokenUrl: config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
      clientId: config.CDFIR_GOOGLE_CLIENT_ID,
      clientSecret: config.CDFIR_GOOGLE_CLIENT_SECRET,
      refreshToken,
      fetchImpl: input.fetchImpl,
    });
  }

  // organization mode
  if (account.provider === 'dropbox') {
    // A Dropbox Business team uses an ordinary refresh token; what makes it
    // "organization" is the Dropbox-API-Select-User header the connector sets
    // per custodian, NOT a different kind of credential. Keeping member choice
    // out of the token is deliberate: one wrong header collects one wrong
    // person, rather than minting a credential scoped to the wrong custodian.
    const row = findSecret(secrets, SecretKind.oauth_refresh_token);
    if (!row) {
      throw new ConnectorCredentialsError('no stored refresh token for this dropbox team');
    }
    const refreshToken = (
      await decryptSecret(kek, account.tenantId, connectorSecretScope(account.id), row)
    ).toString('utf8');
    return new DropboxDelegatedTokenSource({
      tokenEndpoint: config.CDFIR_DROPBOX_OAUTH_TOKEN_URL,
      clientId: config.CDFIR_DROPBOX_CLIENT_ID,
      clientSecret: config.CDFIR_DROPBOX_CLIENT_SECRET,
      refreshToken,
      fetchImpl: input.fetchImpl,
    });
  }

  if (account.provider === 'microsoft') {
    if (account.externalTenantId.length === 0) {
      throw new ConnectorCredentialsError('organization connector has no external tenant id');
    }
    // Production uses the configured app registration. DEMO-ONLY FALLBACK:
    // when no app registration is configured AND the account carries a stored
    // per-connector client_secret (only scripts/demo-seed.ts writes one), use
    // it with the fixed client id 'demo-client' against the fake provider.
    let clientId = config.CDFIR_MS_CLIENT_ID;
    let clientSecret = config.CDFIR_MS_CLIENT_SECRET;
    if (clientId.length === 0) {
      const row = findSecret(secrets, SecretKind.client_secret);
      if (row) {
        clientId = 'demo-client';
        clientSecret = (
          await decryptSecret(kek, account.tenantId, connectorSecretScope(account.id), row)
        ).toString('utf8');
      }
    }
    return new MicrosoftAppTokenSource({
      msLoginBaseUrl: config.CDFIR_MS_LOGIN_BASE_URL,
      tenantId: account.externalTenantId,
      clientId,
      clientSecret,
      fetchImpl: input.fetchImpl,
    });
  }

  const row = findSecret(secrets, SecretKind.service_account_key);
  if (!row) throw new ConnectorCredentialsError('no stored service-account key for this connector');
  const scope = connectorSecretScope(account.id);
  const raw = (await decryptSecret(kek, account.tenantId, scope, row)).toString('utf8');
  const key = parseServiceAccountKey(raw);
  if (!key) throw new ConnectorCredentialsError('stored service-account key is malformed');
  const impersonateEmail = input.impersonateEmail ?? account.externalIdentity;
  return new GoogleServiceAccountTokenSource({
    googleOauthTokenUrl: config.CDFIR_GOOGLE_OAUTH_TOKEN_URL,
    serviceAccountJson: key,
    scopes: GOOGLE_DWD_SCOPES,
    impersonateEmail,
    allowedDomains: account.allowedDomains,
    fetchImpl: input.fetchImpl,
  });
}
