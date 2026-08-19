/**
 * Decisions for the health checker, kept separate from the probes that gather
 * the data so they can be tested without a server, a disk, or a clock.
 *
 * Every threshold here exists because the thing it watches has already failed
 * silently at least once on this deployment.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Disk: warn early enough to act, fail before writes start failing. */
export const DISK_WARN_PERCENT = 80;
export const DISK_FAIL_PERCENT = 90;

/**
 * Nightly backups run at 03:15 UTC, so consecutive runs are ~24h apart.
 * Allowing 30h means ordinary drift or a slow run does not page, while a
 * skipped night does.
 */
export const BACKUP_MAX_AGE_HOURS = 30;

/** Certificates renew automatically; these windows catch a renewal that didn't. */
export const CERT_WARN_DAYS = 21;
export const CERT_FAIL_DAYS = 7;

/** Pull the "Use%" column out of `df -h /` output. */
export function parseDfCapacity(dfOutput: string): number | null {
  for (const line of dfOutput.split('\n')) {
    const match = /(\d+)%/.exec(line);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

export function evaluateDisk(usedPercent: number | null): CheckResult {
  if (usedPercent === null) {
    return { name: 'disk', status: 'fail', detail: 'could not read disk usage' };
  }
  const detail = `root filesystem ${String(usedPercent)}% used`;
  if (usedPercent >= DISK_FAIL_PERCENT) return { name: 'disk', status: 'fail', detail };
  if (usedPercent >= DISK_WARN_PERCENT) return { name: 'disk', status: 'warn', detail };
  return { name: 'disk', status: 'ok', detail };
}

export function evaluateBackupAge(lastBackupAt: Date | null, now: Date): CheckResult {
  if (lastBackupAt === null) {
    return { name: 'backup', status: 'fail', detail: 'no backup found' };
  }
  const hours = (now.getTime() - lastBackupAt.getTime()) / 3_600_000;
  const detail = `newest backup is ${hours.toFixed(1)} hours old (${lastBackupAt.toISOString()})`;
  return {
    name: 'backup',
    status: hours > BACKUP_MAX_AGE_HOURS ? 'fail' : 'ok',
    detail,
  };
}

export function evaluateCertExpiry(notAfter: Date | null, now: Date): CheckResult {
  if (notAfter === null) {
    return { name: 'tls', status: 'fail', detail: 'could not read certificate expiry' };
  }
  const days = (notAfter.getTime() - now.getTime()) / 86_400_000;
  const detail = `certificate expires in ${days.toFixed(1)} days (${notAfter.toISOString()})`;
  if (days <= CERT_FAIL_DAYS) return { name: 'tls', status: 'fail', detail };
  if (days <= CERT_WARN_DAYS) return { name: 'tls', status: 'warn', detail };
  return { name: 'tls', status: 'ok', detail };
}

/**
 * /readyz probes the database AND object storage. Names the failing dependency:
 * storage credentials were wrong here for days while a shallower health check
 * kept reporting the service fine.
 */
export function evaluateReadyz(httpStatus: number, body: string): CheckResult {
  if (httpStatus !== 200) {
    return { name: 'api', status: 'fail', detail: `readyz returned HTTP ${String(httpStatus)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { name: 'api', status: 'fail', detail: 'readyz body was not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { name: 'api', status: 'fail', detail: 'readyz body was not an object' };
  }
  const checks = (parsed as { checks?: unknown }).checks;
  if (typeof checks !== 'object' || checks === null) {
    return { name: 'api', status: 'fail', detail: 'readyz reported no dependency checks' };
  }
  const bad = Object.entries(checks as Record<string, unknown>)
    .filter(([, value]) => value !== 'ok')
    .map(([key, value]) => `${key}=${String(value)}`);
  if (bad.length > 0) {
    return { name: 'api', status: 'fail', detail: `dependency not ok: ${bad.join(', ')}` };
  }
  return { name: 'api', status: 'ok', detail: 'database and object storage ok' };
}

/**
 * Expects `docker ps --format '{{.Names}}\t{{.Status}}'`. A container that is
 * absent counts the same as one that is unhealthy — the worker ran for hours
 * reporting healthy while its queue connection was refused, so "present" alone
 * is not enough.
 */
export function evaluateContainers(psOutput: string, expected: readonly string[]): CheckResult {
  const statusByName = new Map<string, string>();
  for (const line of psOutput.split('\n')) {
    const [name, status] = line.split('\t');
    if (name !== undefined && name !== '' && status !== undefined) {
      statusByName.set(name.trim(), status.trim());
    }
  }

  const problems: string[] = [];
  for (const name of expected) {
    const status = statusByName.get(name);
    if (status === undefined) {
      problems.push(`${name}=missing`);
    } else if (!status.startsWith('Up') || status.includes('unhealthy')) {
      problems.push(`${name}=${status}`);
    }
  }

  return problems.length > 0
    ? { name: 'containers', status: 'fail', detail: problems.join(', ') }
    : { name: 'containers', status: 'ok', detail: `${String(expected.length)} containers up` };
}

export interface Summary {
  status: CheckStatus;
  /** True only for failures: warnings must not train the operator to ignore alerts. */
  shouldAlert: boolean;
  /** Human-readable body, failures first. Sent as the ping payload. */
  text: string;
}

const RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2 };

export function summarize(results: readonly CheckResult[]): Summary {
  if (results.length === 0) {
    // A checker that tested nothing has not proven anything is healthy.
    return { status: 'fail', shouldAlert: true, text: 'no checks ran' };
  }
  const worst = results.reduce<CheckStatus>(
    (acc, r) => (RANK[r.status] < RANK[acc] ? r.status : acc),
    'ok',
  );
  const ordered = [...results].sort((a, b) => RANK[a.status] - RANK[b.status]);
  const text = ordered.map((r) => `[${r.status.toUpperCase()}] ${r.name}: ${r.detail}`).join('\n');
  return { status: worst, shouldAlert: worst === 'fail', text };
}
