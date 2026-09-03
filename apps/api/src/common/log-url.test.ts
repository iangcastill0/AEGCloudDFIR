import { describe, expect, it } from 'vitest';
import { logSafeUrl } from './log-url.js';

/**
 * Found in a live staging log:
 *
 *   url: /api/v1/connectors/callback/slack?code=5258767683554.119748...&state=p7jrXEc...
 *
 * That is an OAuth authorization code written into an access log. It is
 * single-use and short-lived, but logs are shipped, retained, and pasted into
 * tickets — and anyone reading one during a live callback could replay it.
 * Every provider callback is affected, not just Slack.
 */
describe('logSafeUrl', () => {
  it('removes an OAuth authorization code', () => {
    const safe = logSafeUrl('/api/v1/connectors/callback/slack?code=5258767683554.11974&state=x');
    expect(safe).not.toContain('5258767683554');
    expect(safe).toContain('/api/v1/connectors/callback/slack');
  });

  it('removes the sealed state, which is a session-bound secret', () => {
    const safe = logSafeUrl('/cb?state=p7jrXEcORRfU5gWm2tJXzztltp-RwhKj');
    expect(safe).not.toContain('p7jrXEcORRfU5gWm2tJXzztltp');
  });

  it('says a parameter was there, rather than hiding that it existed', () => {
    // Knowing a callback carried a code is useful; knowing the code is not.
    expect(logSafeUrl('/cb?code=abc')).toBe('/cb?code=[redacted]');
  });

  it('keeps parameters that are not credentials', () => {
    // Paging and filters are exactly what a log is read for.
    expect(logSafeUrl('/api/v1/collections?limit=100&cursor=abc')).toBe(
      '/api/v1/collections?limit=100&cursor=abc',
    );
  });

  it('redacts every known credential parameter', () => {
    for (const key of ['code', 'state', 'token', 'access_token', 'refresh_token', 'id_token']) {
      const safe = logSafeUrl(`/cb?${key}=SECRETVALUE`);
      expect(safe, key).not.toContain('SECRETVALUE');
    }
  });

  it('leaves a URL with no query string untouched', () => {
    expect(logSafeUrl('/healthz')).toBe('/healthz');
  });

  it('never throws on a malformed URL', () => {
    // A logger that can crash on a strange request is worse than one that logs
    // a little less.
    expect(() => logSafeUrl('%%%not a url%%%')).not.toThrow();
    expect(() => logSafeUrl('')).not.toThrow();
  });

  it('handles a repeated parameter', () => {
    const safe = logSafeUrl('/cb?code=one&code=two');
    expect(safe).not.toContain('one');
    expect(safe).not.toContain('two');
  });
});
