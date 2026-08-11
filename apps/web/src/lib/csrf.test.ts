import { describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME, csrfHeaderFromCookies, methodNeedsCsrf, readCookieValue } from './csrf';

describe('readCookieValue', () => {
  it('finds the ev_csrf value in a multi-cookie jar', () => {
    const jar = 'ev_session=abc.def; ev_csrf=tok-123; theme=dark';
    expect(readCookieValue(jar, 'ev_csrf')).toBe('tok-123');
  });

  it('does not match cookies whose name merely ends with the target', () => {
    expect(readCookieValue('xev_csrf=nope; ev_csrf=yes', 'ev_csrf')).toBe('yes');
  });

  it('decodes percent-encoded values and tolerates undecodable ones', () => {
    expect(readCookieValue('ev_csrf=a%2Fb', 'ev_csrf')).toBe('a/b');
    expect(readCookieValue('ev_csrf=%E0%A4%A', 'ev_csrf')).toBe('%E0%A4%A');
  });

  it('returns null when absent or the jar is empty', () => {
    expect(readCookieValue('', 'ev_csrf')).toBeNull();
    expect(readCookieValue('other=1', 'ev_csrf')).toBeNull();
  });

  it('handles values containing = signs', () => {
    expect(readCookieValue('ev_csrf=a=b=c', 'ev_csrf')).toBe('a=b=c');
  });
});

describe('csrf header injection', () => {
  it('builds the X-CSRF-Token header from the cookie jar', () => {
    expect(csrfHeaderFromCookies('ev_csrf=tok')).toEqual({ [CSRF_HEADER_NAME]: 'tok' });
  });

  it('signals bootstrap needed when the cookie is missing', () => {
    expect(csrfHeaderFromCookies('ev_session=x')).toBeNull();
  });

  it('is required exactly for mutating methods', () => {
    expect(methodNeedsCsrf('GET')).toBe(false);
    expect(methodNeedsCsrf('head')).toBe(false);
    expect(methodNeedsCsrf('OPTIONS')).toBe(false);
    expect(methodNeedsCsrf('POST')).toBe(true);
    expect(methodNeedsCsrf('patch')).toBe(true);
    expect(methodNeedsCsrf('DELETE')).toBe(true);
  });
});
