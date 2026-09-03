/**
 * Strip credentials out of a URL before it reaches a log.
 *
 * Found in a live staging log during the first successful Slack sign-in:
 *
 *   url: /api/v1/connectors/callback/slack?code=5258767683554.11974...&state=p7jrXEc...
 *
 * That is an OAuth authorization code in an access log. It is single-use and
 * short-lived, so a logged one is usually spent — but logs are shipped,
 * retained, and pasted into tickets, and anyone reading one during a live
 * callback could replay the code before the browser does. The sealed `state`
 * value is a browser-bound secret in the same way.
 *
 * Every provider callback passes its code this way, so this affects Microsoft,
 * Google, Dropbox and Slack equally.
 *
 * The parameter NAME is kept and only the value replaced: knowing that a
 * callback carried a code is useful when reading a log, and knowing the code is
 * not.
 */

/** Query parameters whose values are credentials. */
const REDACTED_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'assertion',
  'session_state',
]);

export function logSafeUrl(url: string): string {
  const split = url.indexOf('?');
  if (split === -1) return url;
  const path = url.slice(0, split);
  const query = url.slice(split + 1);

  try {
    const params = new URLSearchParams(query);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (!REDACTED_PARAMS.has(key.toLowerCase())) continue;
      params.set(key, '[redacted]');
      changed = true;
    }
    if (!changed) return url;
    return `${path}?${decodeURIComponent(params.toString())}`;
  } catch {
    // A logger that can crash on a strange request is worse than one that logs
    // slightly less, so anything unparseable loses its whole query string.
    return `${path}?[unparsed]`;
  }
}
