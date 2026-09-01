/**
 * OAuth token machinery for both providers and both connection modes.
 *
 * Least-privilege READ-ONLY scope sets are exported as constants. Token
 * responses are validated with zod. Secrets never appear in error messages.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';
import { DEFAULT_TIMEOUT_MS, sanitizeUrl, type FetchLike } from './http.js';
import { DomainNotAllowedError, ProviderAuthError, type TokenProvider } from './types.js';

// ---------------------------------------------------------------------------
// Scope constants (contract: least-privilege, read-only)
// ---------------------------------------------------------------------------

/**
 * Never let a browser session decide which account gets connected.
 *
 * Reported from the field: connecting Microsoft 365 silently reused the account
 * already signed in, with no chooser shown. For an evidence tool that is a
 * chain-of-custody problem — the wrong custodian's mailbox is collected and
 * nothing in the product says so. `select_account` makes the operator choose
 * every time, even when only one session exists.
 *
 * Every authorization URL builder here sets it, and a test asserts that for all
 * of them, so a provider added later inherits the rule instead of rediscovering
 * the bug.
 */
export const FORCE_ACCOUNT_SELECTION = 'select_account';

export const MICROSOFT_DELEGATED_SCOPES: readonly string[] = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Files.Read',
];

/** Added only when the user explicitly selects shared content. */
export const MICROSOFT_DELEGATED_SHARED_CONTENT_SCOPE = 'Files.Read.All';

/** Application permissions granted via admin consent (documentation constant). */
export const MICROSOFT_ORG_APP_PERMISSIONS: readonly string[] = [
  'Mail.Read',
  'Files.Read.All',
  'User.Read.All',
];

export const MICROSOFT_APP_TOKEN_SCOPE = 'https://graph.microsoft.com/.default';

export const GOOGLE_DELEGATED_SCOPES: readonly string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

export const GOOGLE_DWD_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
];

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// ---------------------------------------------------------------------------
// Audit-log scope constants (least-privilege, read-only)
// ---------------------------------------------------------------------------

/** App token scope for the Office 365 Management Activity API. */
export const MICROSOFT_MANAGEMENT_ACTIVITY_APP_SCOPE = 'https://manage.office.com/.default';

/** App token scope for Microsoft Graph audit logs. */
export const MICROSOFT_GRAPH_AUDIT_APP_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * Application permissions (admin-consented) that back the audit app tokens:
 * - ActivityFeed.Read → Office 365 Management Activity API content feed.
 * - AuditLog.Read.All → Graph /auditLogs/directoryAudits and /signIns.
 */
export const MICROSOFT_AUDIT_ORG_APP_PERMISSIONS: readonly string[] = [
  'ActivityFeed.Read',
  'AuditLog.Read.All',
];

/** DWD scope for the Admin SDK Reports (audit activities), read-only. */
export const GOOGLE_REPORTS_AUDIT_SCOPE =
  'https://www.googleapis.com/auth/admin.reports.audit.readonly';

/** DWD scope for Google Vault, read-only (enumerate matters/holds/exports). */
export const GOOGLE_VAULT_READONLY_SCOPE = 'https://www.googleapis.com/auth/ediscovery.readonly';

/** DWD scope set for the two Google audit sources. */
export const GOOGLE_AUDIT_DWD_SCOPES: readonly string[] = [
  GOOGLE_REPORTS_AUDIT_SCOPE,
  GOOGLE_VAULT_READONLY_SCOPE,
];

// ---------------------------------------------------------------------------
// Token response validation
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().default(3600),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface ExchangedTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  scope?: string;
}

const errorBodySchema = z.object({ error: z.string().optional() });

async function postTokenForm(
  url: string,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<ExchangedTokens> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderAuthError(`token request failed to reach ${sanitizeUrl(url)}`);
  }
  if (!response.ok) {
    let providerCode: string | undefined;
    try {
      providerCode = errorBodySchema.parse(await response.json()).error;
    } catch {
      providerCode = undefined;
    }
    // Only the OAuth error code (e.g. invalid_grant) is echoed, never the body.
    throw new ProviderAuthError(
      `token endpoint ${sanitizeUrl(url)} returned HTTP ${response.status}`,
      { status: response.status, providerCode },
    );
  }
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderAuthError(`token endpoint ${sanitizeUrl(url)} returned a malformed response`);
  }
  return {
    accessToken: parsed.data.access_token,
    expiresInSeconds: parsed.data.expires_in,
    refreshToken: parsed.data.refresh_token,
    scope: parsed.data.scope,
  };
}

// ---------------------------------------------------------------------------
// Caching base
// ---------------------------------------------------------------------------

/** Cache skew: a token is considered expired 60s before its real expiry. */
const EXPIRY_SKEW_MS = 60_000;

abstract class CachingTokenSource implements TokenProvider {
  private cached?: { token: string; expiresAtMs: number };
  protected readonly nowImpl: () => number;

  constructor(now?: () => number) {
    this.nowImpl = now ?? Date.now;
  }

  protected abstract fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }>;

  async getAccessToken(): Promise<string> {
    if (this.cached !== undefined && this.nowImpl() < this.cached.expiresAtMs - EXPIRY_SKEW_MS) {
      return this.cached.token;
    }
    const fresh = await this.fetchToken();
    this.cached = {
      token: fresh.accessToken,
      expiresAtMs: this.nowImpl() + fresh.expiresInSeconds * 1000,
    };
    return fresh.accessToken;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/** Fixed-token provider for tests and the clearly-labeled demo mode. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  getAccessToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
  invalidate(): void {
    // nothing cached
  }
}

// ---------------------------------------------------------------------------
// Microsoft
// ---------------------------------------------------------------------------

export interface MicrosoftDelegatedTokenSourceOptions {
  msLoginBaseUrl: string;
  /** Entra tenant segment; 'common' supports both personal and work/school accounts. */
  tenant?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: readonly string[];
  /** Microsoft rotates refresh tokens: persist the replacement here. */
  onTokensRotated?: (newRefreshToken: string) => Promise<void>;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class MicrosoftDelegatedTokenSource extends CachingTokenSource {
  private refreshToken: string;
  private readonly opts: MicrosoftDelegatedTokenSourceOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: MicrosoftDelegatedTokenSourceOptions) {
    super(opts.now);
    this.opts = opts;
    this.refreshToken = opts.refreshToken;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  protected async fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const tenant = this.opts.tenant ?? 'common';
    const url = `${this.opts.msLoginBaseUrl}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
    const tokens = await postTokenForm(
      url,
      {
        grant_type: 'refresh_token',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: this.refreshToken,
        scope: this.opts.scopes.join(' '),
      },
      this.fetchImpl,
    );
    if (tokens.refreshToken !== undefined && tokens.refreshToken !== this.refreshToken) {
      this.refreshToken = tokens.refreshToken;
      await this.opts.onTokensRotated?.(tokens.refreshToken);
    }
    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  }
}

export interface MicrosoftAppTokenSourceOptions {
  msLoginBaseUrl: string;
  /** Organization mode requires the tenant-specific endpoint (admin consent granted there). */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class MicrosoftAppTokenSource extends CachingTokenSource {
  private readonly opts: MicrosoftAppTokenSourceOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: MicrosoftAppTokenSourceOptions) {
    super(opts.now);
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  protected async fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const url = `${this.opts.msLoginBaseUrl}/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`;
    const tokens = await postTokenForm(
      url,
      {
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        scope: this.opts.scope ?? MICROSOFT_APP_TOKEN_SCOPE,
      },
      this.fetchImpl,
    );
    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export interface GoogleDelegatedTokenSourceOptions {
  googleOauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class GoogleDelegatedTokenSource extends CachingTokenSource {
  private readonly opts: GoogleDelegatedTokenSourceOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GoogleDelegatedTokenSourceOptions) {
    super(opts.now);
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  protected async fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const tokens = await postTokenForm(
      this.opts.googleOauthTokenUrl,
      {
        grant_type: 'refresh_token',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: this.opts.refreshToken,
      },
      this.fetchImpl,
    );
    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  }
}

export interface GoogleServiceAccountTokenSourceOptions {
  googleOauthTokenUrl: string;
  serviceAccountJson: { client_email: string; private_key: string };
  scopes: readonly string[];
  /** Custodian mailbox to impersonate via domain-wide delegation. */
  impersonateEmail: string;
  /** Impersonation is limited to these verified tenant domains. */
  allowedDomains: readonly string[];
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Domain-wide delegation token source. Builds an RS256 JWT assertion
 * (iss = service account, sub = impersonated custodian) and exchanges it.
 * Throws DomainNotAllowedError at construction when the impersonated user's
 * domain is not on the tenant's allowlist (case-insensitive).
 */
export class GoogleServiceAccountTokenSource extends CachingTokenSource {
  private readonly opts: GoogleServiceAccountTokenSourceOptions;
  private readonly fetchImpl: FetchLike;
  private keyPromise?: Promise<CryptoKey>;

  constructor(opts: GoogleServiceAccountTokenSourceOptions) {
    super(opts.now);
    const domain = opts.impersonateEmail.split('@')[1]?.toLowerCase() ?? '';
    const allowed = opts.allowedDomains.map((d) => d.toLowerCase());
    if (domain === '' || !allowed.includes(domain)) {
      throw new DomainNotAllowedError(
        `impersonation of a user in domain '${domain}' is not allowed for this connection`,
      );
    }
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private signingKey(): Promise<CryptoKey> {
    this.keyPromise ??= importPKCS8(this.opts.serviceAccountJson.private_key, 'RS256');
    return this.keyPromise;
  }

  protected async fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const key = await this.signingKey();
    const iat = Math.floor(this.nowImpl() / 1000);
    const assertion = await new SignJWT({
      scope: this.opts.scopes.join(' '),
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.opts.serviceAccountJson.client_email)
      .setSubject(this.opts.impersonateEmail)
      .setAudience(this.opts.googleOauthTokenUrl)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const tokens = await postTokenForm(
      this.opts.googleOauthTokenUrl,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      },
      this.fetchImpl,
    );
    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  }
}

// ---------------------------------------------------------------------------
// Authorization / consent URL builders and code exchange
// ---------------------------------------------------------------------------

export interface MicrosoftAuthorizationUrlOptions {
  msLoginBaseUrl: string;
  tenant?: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  /** S256 PKCE code challenge (base64url of SHA-256 of the verifier). */
  codeChallenge: string;
}

export function buildMicrosoftAuthorizationUrl(opts: MicrosoftAuthorizationUrlOptions): string {
  const tenant = opts.tenant ?? 'common';
  const url = new URL(`${opts.msLoginBaseUrl}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Without this Microsoft reuses the browser's current session and never shows
  // a chooser, so the connected identity is whoever happened to be signed in.
  url.searchParams.set('prompt', FORCE_ACCOUNT_SELECTION);
  return url.toString();
}

export interface MicrosoftAdminConsentUrlOptions {
  msLoginBaseUrl: string;
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state?: string;
}

/** Entra admin-consent URL for organization (application permissions) mode. */
export function buildMicrosoftAdminConsentUrl(opts: MicrosoftAdminConsentUrlOptions): string {
  const url = new URL(`${opts.msLoginBaseUrl}/${encodeURIComponent(opts.tenantId)}/adminconsent`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  if (opts.state !== undefined) url.searchParams.set('state', opts.state);
  // Same rule as the sign-in URLs: the admin granting tenant-wide access must be
  // chosen deliberately, not inherited from whoever the browser is signed in as.
  url.searchParams.set('prompt', FORCE_ACCOUNT_SELECTION);
  return url.toString();
}

export interface GoogleAuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  /** Override for tests; defaults to the public Google endpoint. */
  authorizationEndpoint?: string;
}

export function buildGoogleAuthorizationUrl(opts: GoogleAuthorizationUrlOptions): string {
  const url = new URL(opts.authorizationEndpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('access_type', 'offline');
  // Both, space separated: `consent` is what guarantees a refresh token, and
  // `select_account` is what stops a single signed-in session being used
  // silently. consent alone forces the consent screen but not the chooser.
  url.searchParams.set('prompt', `${FORCE_ACCOUNT_SELECTION} consent`);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Dropbox
// ---------------------------------------------------------------------------

export const DROPBOX_AUTHORIZATION_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';

/**
 * Scopes for read-only collection.
 *
 * Deliberately no write scope of any kind. A forensic tool must not be able to
 * change the custodian's Dropbox, and a scope that is never requested cannot be
 * misused later by a bug or a stolen token.
 */
export const DROPBOX_DELEGATED_SCOPES: readonly string[] = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'sharing.read',
];

/**
 * Scopes for a Dropbox Business team grant.
 *
 * `events.read` is the team event log — the provider-side forensic record. The
 * member scopes are what let a collection address one custodian at a time
 * through `Dropbox-API-Select-User`.
 *
 * Still read-only. A team token reaches every member of the team, which makes
 * the absence of any write scope matter more here, not less.
 */
export const DROPBOX_TEAM_SCOPES: readonly string[] = [
  'team_info.read',
  'team_data.member',
  'members.read',
  'events.read',
  'files.metadata.read',
  'files.content.read',
  'sharing.read',
];

export interface DropboxAuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  /** S256 PKCE code challenge (base64url of SHA-256 of the verifier). */
  codeChallenge: string;
  /** Override for tests; defaults to the public Dropbox endpoint. */
  authorizationEndpoint?: string;
}

export function buildDropboxAuthorizationUrl(opts: DropboxAuthorizationUrlOptions): string {
  const url = new URL(opts.authorizationEndpoint ?? DROPBOX_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', (opts.scopes ?? DROPBOX_DELEGATED_SCOPES).join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Without this a long-lived refresh token is never issued and the connector
  // stops working after a few hours.
  url.searchParams.set('token_access_type', 'offline');
  // Dropbox has no `prompt` parameter. This is its equivalent, and it is the
  // stronger of the two options: force_reapprove only re-shows the approval
  // screen for the account already signed in, while this makes the person
  // authenticate, so they choose the account deliberately.
  url.searchParams.set('force_reauthentication', 'true');
  return url.toString();
}

/**
 * Does this sign-in URL stop the browser's current session being adopted?
 *
 * Providers spell this differently — Microsoft and Google use `prompt`, Dropbox
 * uses `force_reauthentication` — so the rule is expressed once, here, rather
 * than as a per-provider assertion that a new connector can quietly skip.
 */
export function forcesAccountSelection(rawUrl: string): boolean {
  const params = new URL(rawUrl).searchParams;
  const prompt = (params.get('prompt') ?? '').split(' ');
  if (prompt.includes(FORCE_ACCOUNT_SELECTION)) return true;
  if (params.get('force_reauthentication') === 'true') return true;
  return false;
}

export interface DropboxCodeExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  /** The PKCE verifier whose challenge was sent to the authorize endpoint. */
  codeVerifier: string;
  /** Override for tests; defaults to the public Dropbox endpoint. */
  tokenEndpoint?: string;
  fetchImpl?: FetchLike;
}

export async function exchangeDropboxAuthorizationCode(
  opts: DropboxCodeExchangeOptions,
): Promise<ExchangedTokens> {
  return postTokenForm(
    opts.tokenEndpoint ?? DROPBOX_TOKEN_ENDPOINT,
    {
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
}

export interface DropboxDelegatedTokenSourceOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Dropbox access tokens last about four hours, so every collection longer than
 * that depends on the refresh grant working. The refresh token itself is only
 * issued when the authorize URL carried `token_access_type=offline`.
 */
export class DropboxDelegatedTokenSource extends CachingTokenSource {
  private readonly opts: DropboxDelegatedTokenSourceOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: DropboxDelegatedTokenSourceOptions) {
    super(opts.now);
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  protected async fetchToken(): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const tokens = await postTokenForm(
      this.opts.tokenEndpoint ?? DROPBOX_TOKEN_ENDPOINT,
      {
        grant_type: 'refresh_token',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: this.opts.refreshToken,
      },
      this.fetchImpl,
    );
    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  }
}

export interface MicrosoftCodeExchangeOptions {
  msLoginBaseUrl: string;
  tenant?: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  scopes: readonly string[];
  fetchImpl?: FetchLike;
}

export async function exchangeMicrosoftAuthorizationCode(
  opts: MicrosoftCodeExchangeOptions,
): Promise<ExchangedTokens> {
  const tenant = opts.tenant ?? 'common';
  return postTokenForm(
    `${opts.msLoginBaseUrl}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
      scope: opts.scopes.join(' '),
    },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
}

export interface GoogleCodeExchangeOptions {
  googleOauthTokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}

export async function exchangeGoogleAuthorizationCode(
  opts: GoogleCodeExchangeOptions,
): Promise<ExchangedTokens> {
  return postTokenForm(
    opts.googleOauthTokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    },
    opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  );
}
