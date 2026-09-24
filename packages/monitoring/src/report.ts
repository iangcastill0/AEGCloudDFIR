/**
 * What happens to the result: tell the dead-man's switch, and say the outcome in
 * the exit code.
 *
 * This lives here rather than in cli.ts because cli.ts is a script — it starts
 * doing things the moment it is imported, so nothing in it can be tested. The
 * rules below are the whole reason this package exists (an alert that reaches a
 * human) and they were the one part with no test at all.
 */
import type { Summary } from './checks.js';

/** Nothing failed and the dead-man's switch was told so. */
export const EXIT_OK = 0;
/** A check failed. The alert was sent. */
export const EXIT_CHECK_FAILED = 1;
/** No ping URL is configured, so nobody was told anything. */
export const EXIT_NOT_CONFIGURED = 2;
/** Every check ran, but the ping could not be delivered. */
export const EXIT_PING_FAILED = 3;

export interface ReportOptions {
  /** healthchecks.io ping URL. Empty means "not configured". */
  pingUrl: string;
  /** Where the human-readable lines go. cli.ts passes process.stdout. */
  write: (text: string) => void;
  /** Injected so tests can point at a real local server. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}

/**
 * healthchecks.io uses the bare URL for "all good" and `<url>/fail` for an alert.
 * Trailing slashes are stripped because a pasted URL often has one, and
 * `…/uuid//fail` is a 404 — a 404 that would look exactly like a delivered alert.
 */
export function pingTarget(pingUrl: string, shouldAlert: boolean): string {
  const base = pingUrl.trim().replace(/\/+$/, '');
  return shouldAlert ? `${base}/fail` : base;
}

/**
 * Print the findings, ping, and return the process exit code.
 *
 * Why an unset ping URL is an ERROR and not a quiet no-op: the checker would
 * otherwise run, find everything healthy, print "nothing was notified", and exit
 * 0. That is a monitor that looks installed and tells nobody — the worst of the
 * three states, because it removes the reason to look. Exiting non-zero puts it
 * in the log and in cron's mail on the very first run.
 *
 * Nothing here throws. A checker that crashes while reporting would send no
 * ping, and although silence is itself an alert, it is a much slower one than
 * saying what went wrong.
 */
export async function report(summary: Summary, options: ReportOptions): Promise<number> {
  const { write } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();

  write(`${now.toISOString()} ${summary.status.toUpperCase()}\n`);
  write(`${summary.text}\n`);

  const pingUrl = options.pingUrl.trim();
  if (pingUrl === '') {
    write(
      'CDFIR_HEALTHCHECK_PING_URL is not set — NOBODY WAS NOTIFIED. ' +
        'Create the check, then put its ping URL in .env. ' +
        'See docs/runbooks/monitoring.md.\n',
    );
    return EXIT_NOT_CONFIGURED;
  }

  const label = summary.shouldAlert ? 'FAIL' : 'ok';
  let delivered = false;
  try {
    const res = await fetchImpl(pingTarget(pingUrl, summary.shouldAlert), {
      method: 'POST',
      body: summary.text,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    delivered = res.ok;
    write(
      `ping ${label} -> HTTP ${String(res.status)}${res.ok ? '' : ' — NOT ACCEPTED, check the URL'}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`ping ${label} could not be delivered: ${message}\n`);
  }

  // A failed check is the headline even when the ping also failed: the ping
  // going missing is already covered by the switch alerting on silence.
  if (summary.shouldAlert) return EXIT_CHECK_FAILED;
  return delivered ? EXIT_OK : EXIT_PING_FAILED;
}
