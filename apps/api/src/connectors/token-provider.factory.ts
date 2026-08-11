import type { AppConfig } from '@evidencevault/config';
import {
  decryptSecret,
  encryptSecret,
  SecretKind,
  type EncryptedSecret,
  type KeyEncryptionProvider,
} from '@evidencevault/database';
import {
  GOOGLE_DWD_SCOPES,
  GoogleDelegatedTokenSource,
  GoogleServiceAccountTokenSource,
  MICROSOFT_DELEGATED_SCOPES,
  MicrosoftAppTokenSource,
  MicrosoftDelegatedTokenSource,
  type FetchLike,
  type TokenProvider,
} from '@evidencevault/connectors';

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
  | 'EV_MS_LOGIN_BASE_URL'
  | 'EV_MS_CLIENT_ID'
  | 'EV_MS_CLIENT_SECRET'
  | 'EV_GOOGLE_OAUTH_TOKEN_URL'
  | 'EV_GOOGLE_CLIENT_ID'
  | 'EV_GOOGLE_CLIENT_SECRET'
>;

export interface ConnectorSecretRecord extends EncryptedSecret {
  id: string;
  kind: SecretKind;
}

export interface ConnectorAccountRecord {
  id: string;
  tenantId: string;
  provider: 'microsoft' | 'google';
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
        msLoginBaseUrl: config.EV_MS_LOGIN_BASE_URL,
        clientId: config.EV_MS_CLIENT_ID,
        clientSecret: config.EV_MS_CLIENT_SECRET,
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
    return new GoogleDelegatedTokenSource({
      googleOauthTokenUrl: config.EV_GOOGLE_OAUTH_TOKEN_URL,
      clientId: config.EV_GOOGLE_CLIENT_ID,
      clientSecret: config.EV_GOOGLE_CLIENT_SECRET,
      refreshToken,
      fetchImpl: input.fetchImpl,
    });
  }

  // organization mode
  if (account.provider === 'microsoft') {
    if (account.externalTenantId.length === 0) {
      throw new ConnectorCredentialsError('organization connector has no external tenant id');
    }
    return new MicrosoftAppTokenSource({
      msLoginBaseUrl: config.EV_MS_LOGIN_BASE_URL,
      tenantId: account.externalTenantId,
      clientId: config.EV_MS_CLIENT_ID,
      clientSecret: config.EV_MS_CLIENT_SECRET,
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
    googleOauthTokenUrl: config.EV_GOOGLE_OAUTH_TOKEN_URL,
    serviceAccountJson: key,
    scopes: GOOGLE_DWD_SCOPES,
    impersonateEmail,
    allowedDomains: account.allowedDomains,
    fetchImpl: input.fetchImpl,
  });
}
