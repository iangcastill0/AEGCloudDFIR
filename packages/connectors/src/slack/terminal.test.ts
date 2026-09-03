import { describe, expect, it } from 'vitest';
import { SlackApiError } from './envelope.js';
import { isTerminalSlackError } from './terminal.js';

/**
 * Observed on the first real Slack collection: a DM the token cannot read
 * returned `channel_not_found`, and the job retried EIGHT times over nearly
 * three minutes before dead-lettering. The answer was never going to change.
 *
 * Retrying a permanent refusal costs real time on a large workspace and buries
 * the transient failures a retry is actually for.
 */
describe('isTerminalSlackError', () => {
  it('does not retry a conversation the token cannot see', () => {
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'channel_not_found' }))).toBe(
      true,
    );
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'not_in_channel' }))).toBe(
      true,
    );
  });

  it('does not retry a missing scope, which needs a new grant', () => {
    // Retrying cannot add a scope. Only re-authorising can.
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'missing_scope' }))).toBe(
      true,
    );
  });

  it('does not retry a revoked or invalid token', () => {
    for (const code of ['token_revoked', 'invalid_auth', 'account_inactive', 'not_authed']) {
      expect(isTerminalSlackError(new SlackApiError('x', { slackError: code })), code).toBe(true);
    }
  });

  it('DOES retry a rate limit and a server fault', () => {
    // These are exactly what retries exist for.
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'ratelimited' }))).toBe(false);
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'internal_error' }))).toBe(
      false,
    );
    expect(
      isTerminalSlackError(new SlackApiError('x', { slackError: 'service_unavailable' })),
    ).toBe(false);
  });

  it('retries an unrecognised code rather than writing it off', () => {
    // A code this version has never seen might be transient. Giving up on it
    // would turn an unknown into a permanent gap in the evidence.
    expect(isTerminalSlackError(new SlackApiError('x', { slackError: 'some_new_code' }))).toBe(
      false,
    );
  });

  it('is false for anything that is not a Slack error', () => {
    expect(isTerminalSlackError(new Error('socket hang up'))).toBe(false);
    expect(isTerminalSlackError('nope')).toBe(false);
  });
});
