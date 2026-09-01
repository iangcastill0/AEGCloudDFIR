import { describe, expect, it } from 'vitest';
import {
  SlackApiError,
  nextSlackCursor,
  readSlackEnvelope,
  slackRetryAfterMs,
} from './envelope.js';

/**
 * Slack answers a FAILED call with HTTP 200 and `{"ok": false, "error": "..."}`.
 *
 * Every other provider here signals failure with a status code, and ensureOk is
 * built on that assumption. Handed a Slack response it sees 200, returns
 * happily, and a collection records zero messages as a complete success — the
 * exact "reports success, silently broken" failure this codebase keeps hitting.
 *
 * So no Slack response may reach the rest of the connector without passing
 * through here first.
 */
describe('readSlackEnvelope', () => {
  it('returns the payload when Slack says ok', () => {
    const body = readSlackEnvelope(
      { ok: true, messages: [{ ts: '1.0' }] },
      'conversations.history',
    );
    expect(body.messages).toHaveLength(1);
  });

  it('THROWS on ok:false even though the status was 200', () => {
    expect(() =>
      readSlackEnvelope({ ok: false, error: 'channel_not_found' }, 'conversations.history'),
    ).toThrow(SlackApiError);
  });

  it('names the Slack error code, which is the whole diagnosis', () => {
    // 'missing_scope' vs 'not_in_channel' vs 'token_revoked' are three entirely
    // different fixes, and Slack has already told us which one it is.
    try {
      readSlackEnvelope({ ok: false, error: 'missing_scope', needed: 'channels:history' }, 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as SlackApiError).slackError).toBe('missing_scope');
      expect((err as SlackApiError).message).toContain('missing_scope');
      expect((err as SlackApiError).message).toContain('channels:history');
    }
  });

  it('refuses a body with no ok field at all', () => {
    // Slack returns an HTML login page for some auth failures. Treating that as
    // a successful empty result would silently collect nothing.
    expect(() => readSlackEnvelope({ messages: [] }, 'conversations.history')).toThrow(
      SlackApiError,
    );
    expect(() => readSlackEnvelope('<html>Sign in</html>', 'conversations.history')).toThrow(
      SlackApiError,
    );
    expect(() => readSlackEnvelope(null, 'conversations.history')).toThrow(SlackApiError);
  });

  it('says which call failed, because one collection makes several', () => {
    try {
      readSlackEnvelope({ ok: false, error: 'ratelimited' }, 'conversations.replies');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('conversations.replies');
    }
  });
});

describe('nextSlackCursor', () => {
  it('reads the cursor out of response_metadata', () => {
    expect(nextSlackCursor({ response_metadata: { next_cursor: 'dXNlcjpV' } })).toBe('dXNlcjpV');
  });

  it('treats an EMPTY cursor as the end, not as a cursor', () => {
    // Slack sends next_cursor: "" on the last page. Passing that back as a
    // cursor restarts the listing, which loops forever.
    expect(nextSlackCursor({ response_metadata: { next_cursor: '' } })).toBeUndefined();
    expect(nextSlackCursor({ response_metadata: {} })).toBeUndefined();
    expect(nextSlackCursor({})).toBeUndefined();
  });
});

describe('slackRetryAfterMs', () => {
  it('reads Retry-After seconds on a 429', () => {
    const headers = new Headers({ 'retry-after': '30' });
    expect(slackRetryAfterMs(headers)).toBe(30_000);
  });

  it('returns undefined when Slack did not say', () => {
    expect(slackRetryAfterMs(new Headers())).toBeUndefined();
    expect(slackRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
  });
});
