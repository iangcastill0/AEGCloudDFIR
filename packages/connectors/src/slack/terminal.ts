/**
 * Which Slack failures can never succeed on a retry.
 *
 * Observed on the first real collection: a DM the token could not read returned
 * `channel_not_found`, and the job retried eight times across nearly three
 * minutes before dead-lettering. The answer was never going to change.
 *
 * On a workspace with hundreds of conversations that wasted time adds up, and
 * worse, it buries the transient failures retries actually exist for.
 *
 * An unrecognised code is treated as retryable on purpose. A code this version
 * has never seen might well be transient, and writing it off would turn an
 * unknown into a permanent gap in the evidence.
 */
import { SlackApiError } from './envelope.js';

const TERMINAL: ReadonlySet<string> = new Set([
  // The token cannot see this conversation. Re-asking cannot change that.
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  // A scope cannot be added by retrying; only a new grant adds one.
  'missing_scope',
  'no_permission',
  // The credential itself is finished.
  'token_revoked',
  'token_expired',
  'invalid_auth',
  'not_authed',
  'account_inactive',
  // The request was malformed, so the same request will fail identically.
  'invalid_arguments',
  'invalid_cursor',
  'invalid_ts_latest',
  'invalid_ts_oldest',
]);

export function isTerminalSlackError(err: unknown): boolean {
  if (!(err instanceof SlackApiError)) return false;
  return TERMINAL.has(err.slackError);
}
