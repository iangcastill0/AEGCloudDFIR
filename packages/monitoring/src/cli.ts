/**
 * Runs every check and reports the result to a dead-man's-switch service.
 *
 * Run from cron on the server:
 *   cd /var/www/AEGCloudDFIR && node --env-file=.env packages/monitoring/dist/cli.js
 *
 * Two layers of protection, deliberately:
 *  - This process reports FAILURES it can see (site down, storage unreachable,
 *    backup missed, disk filling, certificate expiring, container unhealthy).
 *  - Silence is itself an alert. If the host dies, or cron stops, or this script
 *    crashes, no ping arrives and the service alerts on the missing ping. An
 *    alarm inside the building cannot ring once the building loses power.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';
import {
  evaluateBackupAge,
  evaluateCertExpiry,
  evaluateContainers,
  DISK_WARN_PERCENT,
  evaluateDisk,
  parseReclaimable,
  evaluateReadyz,
  parseDfCapacity,
  summarize,
  type CheckResult,
} from './checks.js';

const run = promisify(execFile);

const API_PORT = process.env.CDFIR_API_HOST_PORT ?? '4000';
const SITE_URL = process.env.CDFIR_WEB_PUBLIC_URL ?? 'https://app.aegclouddfir.com';
const PING_URL = process.env.CDFIR_HEALTHCHECK_PING_URL ?? '';
const BACKUP_STAMP = process.env.CDFIR_BACKUP_STAMP_FILE ?? '/var/www/AEGCloudDFIR/.last-backup';
const CONTAINERS = (
  process.env.CDFIR_EXPECTED_CONTAINERS ??
  'cdfir-api-1,cdfir-web-1,cdfir-worker-1,cdfir-postgres-1,cdfir-redis-1,cdfir-opensearch-1'
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

/** Never let one probe's exception hide the other checks. */
async function attempt(name: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', detail: `probe failed: ${message}` };
  }
}

async function checkApi(): Promise<CheckResult> {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/readyz`, {
    signal: AbortSignal.timeout(15_000),
  });
  return evaluateReadyz(res.status, await res.text());
}

async function checkSite(): Promise<CheckResult> {
  const res = await fetch(SITE_URL, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
  const ok = res.status >= 200 && res.status < 400;
  return {
    name: 'site',
    status: ok ? 'ok' : 'fail',
    detail: `${SITE_URL} returned HTTP ${String(res.status)}`,
  };
}

/**
 * Docker's reclaimable bytes, or undefined when it cannot be read.
 *
 * Never throws: this is decoration on an alert, and a failed probe must not stop
 * the alert firing. That is why the breakdown is optional in evaluateDisk.
 */
async function reclaimableDockerBytes(): Promise<number | undefined> {
  try {
    const { stdout } = await run('docker', ['system', 'df', '--format', '{{.Reclaimable}}']);
    return parseReclaimable(stdout);
  } catch {
    return undefined;
  }
}

async function checkDisk(): Promise<CheckResult> {
  const { stdout } = await run('df', ['-h', '/']);
  const usedPercent = parseDfCapacity(stdout);
  // Only worth gathering when there is something to report.
  if (usedPercent === null || usedPercent < DISK_WARN_PERCENT) {
    return evaluateDisk(usedPercent);
  }
  return evaluateDisk(usedPercent, { reclaimableDockerBytes: await reclaimableDockerBytes() });
}

async function checkContainers(): Promise<CheckResult> {
  const { stdout } = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}']);
  return evaluateContainers(stdout, CONTAINERS);
}

async function checkBackup(): Promise<CheckResult> {
  // Written by scripts/backup-postgres.sh only after the upload was re-read and
  // its hash re-verified, so a fresh stamp means a backup that actually exists.
  let raw: string;
  try {
    raw = await readFile(BACKUP_STAMP, 'utf8');
  } catch {
    return evaluateBackupAge(null, new Date());
  }
  const when = new Date(raw.trim());
  return evaluateBackupAge(Number.isNaN(when.getTime()) ? null : when, new Date());
}

async function checkCert(): Promise<CheckResult> {
  // Node's TLS rather than the openssl binary: the server does not have openssl
  // installed, and a probe that depends on a missing tool reports "fail" for the
  // wrong reason — which is worse than no probe at all.
  const host = new URL(SITE_URL).hostname;
  const notAfter = await new Promise<Date | null>((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const raw: unknown = (cert as { valid_to?: unknown }).valid_to;
      if (typeof raw !== 'string') {
        resolve(null);
        return;
      }
      const parsed = new Date(raw);
      resolve(Number.isNaN(parsed.getTime()) ? null : parsed);
    });
    socket.once('error', () => {
      resolve(null);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
  return evaluateCertExpiry(notAfter, new Date());
}

const results = await Promise.all([
  attempt('api', checkApi),
  attempt('site', checkSite),
  attempt('containers', checkContainers),
  attempt('disk', checkDisk),
  attempt('backup', checkBackup),
  attempt('tls', checkCert),
]);

const summary = summarize(results);
process.stdout.write(`${new Date().toISOString()} ${summary.status.toUpperCase()}\n`);
process.stdout.write(`${summary.text}\n`);

if (PING_URL === '') {
  process.stdout.write('CDFIR_HEALTHCHECK_PING_URL is not set — nothing was notified\n');
} else {
  const target = summary.shouldAlert ? `${PING_URL.replace(/\/$/, '')}/fail` : PING_URL;
  try {
    const res = await fetch(target, {
      method: 'POST',
      body: summary.text,
      signal: AbortSignal.timeout(15_000),
    });
    process.stdout.write(
      `ping ${summary.shouldAlert ? 'FAIL' : 'ok'} -> HTTP ${String(res.status)}\n`,
    );
  } catch (err) {
    // Losing the ping is itself detected: the service alerts on silence.
    console.error(`ping failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Non-zero so a human reading cron output or the log can see it at a glance.
process.exitCode = summary.shouldAlert ? 1 : 0;
