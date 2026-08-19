import { describe, expect, it } from 'vitest';
import {
  BACKUP_MAX_AGE_HOURS,
  evaluateBackupAge,
  evaluateCertExpiry,
  evaluateContainers,
  evaluateDisk,
  evaluateReadyz,
  parseDfCapacity,
  summarize,
  type CheckResult,
} from './checks.js';

const NOW = new Date('2026-08-19T18:00:00.000Z');

describe('parseDfCapacity', () => {
  it('reads the used percentage from df output', () => {
    const df = [
      'Filesystem                         Size  Used Avail Use% Mounted on',
      '/dev/mapper/ubuntu--vg-ubuntu--lv   98G   63G   31G  67% /',
    ].join('\n');
    expect(parseDfCapacity(df)).toBe(67);
  });

  it('returns null rather than guessing when the output is unexpected', () => {
    // Guessing 0 would mean a broken probe reports a healthy disk — the exact
    // failure this whole package exists to catch.
    expect(parseDfCapacity('')).toBeNull();
    expect(parseDfCapacity('nonsense')).toBeNull();
  });
});

describe('evaluateDisk', () => {
  it.each([
    [50, 'ok'],
    [79, 'ok'],
    [80, 'warn'],
    [90, 'fail'],
    [100, 'fail'],
  ])('%i%% used is %s', (pct, expected) => {
    expect(evaluateDisk(pct).status).toBe(expected);
  });

  it('fails when the percentage could not be read', () => {
    const r = evaluateDisk(null);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/could not/i);
  });

  it('says the number, so the alert is actionable without logging in', () => {
    expect(evaluateDisk(93).detail).toContain('93%');
  });
});

describe('evaluateBackupAge', () => {
  it('accepts a backup from last night', () => {
    const last = new Date('2026-08-19T03:15:00.000Z');
    expect(evaluateBackupAge(last, NOW).status).toBe('ok');
  });

  it('fails when the newest backup is older than the window', () => {
    // The real incident: backups stopped for a day and nothing said so.
    const last = new Date('2026-08-17T03:15:00.000Z');
    const r = evaluateBackupAge(last, NOW);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/hours old/);
  });

  it('fails when no backup exists at all', () => {
    const r = evaluateBackupAge(null, NOW);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/no backup/i);
  });

  it('allows a full day plus slack, so a late cron is not an alert', () => {
    // Nightly at 03:15 means ~24h between runs; alerting at 24h exactly would
    // page on every few minutes of drift.
    expect(BACKUP_MAX_AGE_HOURS).toBeGreaterThan(24);
    const justInside = new Date(NOW.getTime() - (BACKUP_MAX_AGE_HOURS - 1) * 3600_000);
    expect(evaluateBackupAge(justInside, NOW).status).toBe('ok');
  });
});

describe('evaluateCertExpiry', () => {
  it('is ok two months out', () => {
    expect(evaluateCertExpiry(new Date('2026-11-11T17:00:14.000Z'), NOW).status).toBe('ok');
  });

  it('warns inside three weeks, so a failed renewal is still fixable', () => {
    expect(evaluateCertExpiry(new Date('2026-09-05T00:00:00.000Z'), NOW).status).toBe('warn');
  });

  it('fails inside a week, and when already expired', () => {
    expect(evaluateCertExpiry(new Date('2026-08-23T00:00:00.000Z'), NOW).status).toBe('fail');
    expect(evaluateCertExpiry(new Date('2026-08-01T00:00:00.000Z'), NOW).status).toBe('fail');
  });

  it('fails when the date could not be read', () => {
    expect(evaluateCertExpiry(null, NOW).status).toBe('fail');
  });
});

describe('evaluateReadyz', () => {
  it('passes only when every dependency reports ok', () => {
    const body = '{"status":"ok","checks":{"database":"ok","objectStorage":"ok"}}';
    expect(evaluateReadyz(200, body).status).toBe('ok');
  });

  it('fails when a dependency is down, and names which one', () => {
    // Storage credentials were wrong for days while /healthz said fine; the
    // alert has to name the failing dependency.
    const body =
      '{"status":"degraded","checks":{"database":"ok","objectStorage":"InvalidAccessKeyId"}}';
    const r = evaluateReadyz(200, body);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('objectStorage');
  });

  it('fails when search is the broken dependency', () => {
    // Search was added to readyz precisely so this alerts. The monitor needs no
    // change to notice — it fails on ANY dependency that is not ok — and this
    // pins that, so a future edit cannot quietly narrow it to database+storage.
    const body =
      '{"status":"degraded","checks":{"database":"ok","objectStorage":"ok","search":"unreachable (AuthenticationException)"}}';
    const r = evaluateReadyz(200, body);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('search');
    expect(r.detail).toContain('AuthenticationException');
  });

  it('fails on a non-200, including nothing at all', () => {
    expect(evaluateReadyz(503, '').status).toBe('fail');
    expect(evaluateReadyz(0, '').status).toBe('fail');
  });

  it('fails on a body that is not the expected shape', () => {
    expect(evaluateReadyz(200, 'not json').status).toBe('fail');
    expect(evaluateReadyz(200, '{}').status).toBe('fail');
  });
});

describe('evaluateContainers', () => {
  const expected = ['cdfir-api-1', 'cdfir-web-1', 'cdfir-worker-1'];

  it('passes when all expected containers are up', () => {
    const rows = [
      'cdfir-api-1\tUp 2 hours (healthy)',
      'cdfir-web-1\tUp 2 hours',
      'cdfir-worker-1\tUp 2 hours (healthy)',
    ].join('\n');
    expect(evaluateContainers(rows, expected).status).toBe('ok');
  });

  it('fails and names a container that is missing entirely', () => {
    const rows = ['cdfir-api-1\tUp 2 hours (healthy)', 'cdfir-web-1\tUp 2 hours'].join('\n');
    const r = evaluateContainers(rows, expected);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('cdfir-worker-1');
  });

  it('fails on an unhealthy or restarting container', () => {
    const rows = [
      'cdfir-api-1\tUp 1 minute (unhealthy)',
      'cdfir-web-1\tUp 2 hours',
      'cdfir-worker-1\tRestarting (1) 5 seconds ago',
    ].join('\n');
    const r = evaluateContainers(rows, expected);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('cdfir-api-1');
    expect(r.detail).toContain('cdfir-worker-1');
  });
});

describe('summarize', () => {
  const ok = (name: string): CheckResult => ({ name, status: 'ok', detail: 'fine' });
  const warn = (name: string): CheckResult => ({ name, status: 'warn', detail: 'getting full' });
  const fail = (name: string): CheckResult => ({ name, status: 'fail', detail: 'down' });

  it('is ok only when nothing is wrong', () => {
    expect(summarize([ok('a'), ok('b')]).status).toBe('ok');
  });

  it('a warning does not page, but is reported', () => {
    // Pinging "fail" for a disk at 80% would train the operator to ignore
    // alerts, which is worse than not having them.
    const s = summarize([ok('a'), warn('disk')]);
    expect(s.status).toBe('warn');
    expect(s.shouldAlert).toBe(false);
    expect(s.text).toContain('disk');
  });

  it('any failure alerts, and the summary leads with what failed', () => {
    const s = summarize([ok('a'), warn('disk'), fail('backup')]);
    expect(s.status).toBe('fail');
    expect(s.shouldAlert).toBe(true);
    expect(s.text.indexOf('backup')).toBeLessThan(s.text.indexOf('disk'));
  });

  it('reports every check, so the ping doubles as a record of what was tested', () => {
    const s = summarize([ok('site'), ok('db'), fail('backup')]);
    for (const name of ['site', 'db', 'backup']) expect(s.text).toContain(name);
  });

  it('treats an empty check list as a failure, not a pass', () => {
    // A checker that ran but tested nothing must not report success.
    const s = summarize([]);
    expect(s.status).toBe('fail');
    expect(s.shouldAlert).toBe(true);
  });
});
