/**
 * Which provider failures can never succeed on a retry.
 *
 * The case this was written for: a customer disabled our application in their
 * Entra tenant part-way through a collection. Every job then failed on
 * `AADSTS7000112: Application ... is disabled`, and every one of them retried
 * the full eight times — 6,720 token requests to Microsoft in five minutes,
 * against an answer that could not change until a human clicked something in
 * another company's admin portal. Beyond the waste, that volume is a good way
 * to get throttled, and it buries the transient failures retries exist for.
 *
 * Mirrors the rule already used for Slack (`isTerminalSlackError`), including
 * the most important part of it: **an unrecognised failure is retryable**.
 * Writing off a code this version has never seen would turn an unknown into a
 * permanent hole in the evidence, and a gap nobody was told about is worse than
 * a slow retry.
 */
import {
  ProviderApiError,
  ProviderAuthError,
  isTerminalSlackError,
} from '@aeg-clouddfir/connectors';

/**
 * OAuth 2 error codes that describe the *client registration*, not a moment in
 * time. Retrying re-sends the same client id and secret and gets the same
 * answer. RFC 6749 §5.2 names all of these.
 */
const TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  // The app is disabled, or not permitted to use this grant. AADSTS7000112.
  'unauthorized_client',
  // Wrong client id, wrong or expired client secret.
  'invalid_client',
  // The grant is finished: a revoked or expired refresh token, a used code.
  // Only a new sign-in fixes it.
  'invalid_grant',
  // The request shape is wrong and will be wrong next time too.
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
]);

/**
 * Provider error codes that mean "this will not exist or be permitted later".
 * Deliberately narrow — everything here has been seen in a real collection.
 */
const TERMINAL_PROVIDER_CODES: ReadonlySet<string> = new Set([
  // Graph: the app has no app-role for this call. Only a new admin consent
  // changes it, and that is a person in another company clicking Accept.
  'Authorization_RequestDenied',
  'AccessDenied',
  // Graph: the custodian has no OneDrive provisioned ("User's mysite not
  // found"). Retried eight times per custodian for something that does not
  // exist and is not going to start existing.
  'ResourceNotFound',
  'ErrorItemNotFound',
  'itemNotFound',
  // Graph: the mailbox is not there (deleted user, unlicensed account).
  'MailboxNotEnabledForRESTAPI',
  'ErrorInvalidUser',
  'ErrorNonExistentMailbox',
  // The query itself is malformed, so every attempt is byte-identical.
  'BadRequest',
  'ErrorInvalidIdMalformed',
]);

export interface PermanentVerdict {
  permanent: boolean;
  /** Short, log-safe reason. Empty when not permanent. */
  reason: string;
}

/**
 * Decide whether a provider failure is worth another attempt.
 *
 * Order matters: an auth error is judged on its OAuth code, an API error on its
 * HTTP status first (429 and 5xx are always retryable, whatever code came with
 * them) and then its provider code.
 */
export function classifyProviderError(err: unknown): PermanentVerdict {
  const no: PermanentVerdict = { permanent: false, reason: '' };

  if (isTerminalSlackError(err)) {
    return { permanent: true, reason: 'slack rejected this permanently' };
  }

  if (err instanceof ProviderAuthError) {
    const code = err.providerCode;
    if (code !== undefined && TERMINAL_OAUTH_CODES.has(code)) {
      return { permanent: true, reason: `oauth ${code}` };
    }
    return no;
  }

  if (err instanceof ProviderApiError) {
    // Throttling and provider outages are exactly what retries are for, even
    // when they arrive carrying a code that appears in the terminal list.
    if (err.status === 429 || err.status >= 500) return no;
    const code = err.providerCode;
    if (code !== undefined && TERMINAL_PROVIDER_CODES.has(code)) {
      return { permanent: true, reason: `provider ${String(err.status)} ${code}` };
    }
    // A 403 that survived a token refresh is a permission decision, not a
    // moment. The refresh already happened inside providerFetch.
    if (err.status === 403) {
      return { permanent: true, reason: 'provider 403 after token refresh' };
    }
    return no;
  }

  return no;
}

export function isPermanentProviderError(err: unknown): boolean {
  return classifyProviderError(err).permanent;
}
