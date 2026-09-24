/**
 * Pins the one decision the whole package rests on: the checker runs ON THE HOST.
 *
 * Three of the six checks are host facts — the root filesystem, the container
 * list, and docker's reclaimable space. Move this into a container to "simplify
 * the deployment" and two things happen, both quiet:
 *
 *  - `df -h /` measures the container's own nearly-empty filesystem, so the alert
 *    reads "4% used" every five minutes while the real disk fills. That is the
 *    2026-08-27 outage exactly: 96% for five hours, PostgreSQL crashed, and it
 *    could not restart because replaying its own log also needed space.
 *  - `docker ps` needs the docker socket mounted in, which hands that container
 *    root-equivalent control of the host — every evidence volume included — even
 *    mounted `:ro`, because `:ro` protects the file, not the API behind it.
 *
 * Neither shows up as a test failure anywhere else, and neither shows up in
 * production as anything but a monitor that says everything is fine. So they are
 * pinned here, in the code and in the two files the host actually runs.
 *
 * Those files live outside this package, so turbo cannot see them in this task's
 * inputs: edit scripts/monitor.sh alone and `pnpm test` replays a cached pass.
 * They are listed in turbo.json `globalDependencies` for that reason. Add any new
 * file this test reads there too, or the pin goes quiet on the Mac.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_STAMP_FILE,
  HOST_DF_ARGV,
  HOST_DOCKER_PS_ARGV,
  evaluateContainers,
  parseDfCapacity,
} from './checks.js';

function repoFile(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

const WRAPPER = 'scripts/monitor.sh';
const CRON_FILE = 'infra/cron/cdfir-monitor';

const wrapper = readFileSync(repoFile(WRAPPER), 'utf8');
const cron = readFileSync(repoFile(CRON_FILE), 'utf8');

/**
 * Comments stripped, so "do not do X" assertions look at what runs.
 *
 * Both files explain in prose why they do NOT use `--env-file` or `docker run`,
 * and a plain text search cannot tell an explanation from an instruction.
 */
function commandsOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const wrapperCommands = commandsOnly(wrapper);
const cronCommands = commandsOnly(cron);
const checksSource = readFileSync(repoFile('packages/monitoring/src/checks.ts'), 'utf8');

/** Ways of running this inside a container, none of which may appear. */
const CONTAINERISED = [
  'docker run',
  'docker exec',
  'docker compose run',
  'docker compose exec',
  'docker.sock',
  'DOCKER_HOST',
  '--privileged',
];

describe('the decision layer takes no settings from the environment', () => {
  it('checks.ts reads no environment variable at all', () => {
    // Pinning the VALUE of HOST_DF_ARGV is not enough, and this was found by
    // trying it: `['-h', process.env.CDFIR_DISK_PATH ?? '/']` still equals
    // ['-h', '/'] in every test, then reads a container's own path in production —
    // a green test suite and a monitor that reports 4% used on a full disk.
    //
    // So checks.ts holds decisions only. Every setting is read in cli.ts, where
    // it is one short list a reviewer can see. That also protects the thresholds:
    // nobody can quietly raise DISK_FAIL_PERCENT on one host.
    expect(checksSource).not.toContain('process.env');
  });
});

describe('the disk check measures the host disk', () => {
  it('asks df about /, and offers no way to point it elsewhere', () => {
    expect([...HOST_DF_ARGV]).toEqual(['-h', '/']);
  });

  it('reads the percentage out of what that command actually prints', () => {
    const real = [
      'Filesystem                         Size  Used Avail Use% Mounted on',
      '/dev/mapper/ubuntu--vg-ubuntu--lv   98G   63G   31G  67% /',
    ].join('\n');
    expect(parseDfCapacity(real)).toBe(67);
  });
});

describe('the container check asks the host docker', () => {
  it('uses the tab-separated format its parser expects', () => {
    expect([...HOST_DOCKER_PS_ARGV]).toEqual(['ps', '--format', '{{.Names}}\t{{.Status}}']);
  });

  it('round-trips a row built from that very format string', () => {
    // Couples the command to the parser. Change the format and this fails, rather
    // than the checker quietly deciding every container is missing.
    const format = HOST_DOCKER_PS_ARGV[2];
    const row = format.replace('{{.Names}}', 'cdfir-api-1').replace('{{.Status}}', 'Up 2 hours');
    expect(evaluateContainers(row, ['cdfir-api-1']).status).toBe('ok');
  });

  it('takes no socket path or remote host, so it can only mean this host', () => {
    expect([...HOST_DOCKER_PS_ARGV].join(' ')).not.toContain('-H');
    expect([...HOST_DOCKER_PS_ARGV].join(' ')).not.toContain('sock');
  });
});

describe(`${WRAPPER} runs the checker natively`, () => {
  it('is executable, or cron runs nothing and says nothing', () => {
    expect(statSync(repoFile(WRAPPER)).mode & 0o111).toBeGreaterThan(0);
    expect(wrapper.startsWith('#!')).toBe(true);
  });

  it('invokes node on the built checker directly', () => {
    expect(wrapper).toContain('packages/monitoring/dist/cli.js');
    expect(wrapper).toContain('command -v node');
  });

  it.each(CONTAINERISED)('does not wrap the checker in a container (%s)', (fragment) => {
    expect(wrapperCommands).not.toContain(fragment);
  });

  it('never sources .env, so a broken line cannot stop the monitoring', () => {
    // An unquoted SSH host key in .env once parsed as a command and silently
    // stopped the nightly backup. Reading one key at a time cannot do that, and
    // it also keeps every other production secret out of this process.
    expect(wrapperCommands).not.toMatch(/^\s*(\.|source)\s+/m);
    expect(wrapperCommands).not.toContain('--env-file');
  });

  it('cannot pile up or hang forever', () => {
    expect(wrapper).toContain('flock');
    expect(wrapper).toContain('timeout');
  });

  it('hands over only the settings the checker needs', () => {
    for (const key of [
      'CDFIR_HEALTHCHECK_PING_URL',
      'CDFIR_WEB_PUBLIC_URL',
      'CDFIR_API_HOST_PORT',
      'CDFIR_EXPECTED_CONTAINERS',
      'CDFIR_BACKUP_STAMP_FILE',
    ]) {
      expect(wrapperCommands).toContain(key);
    }
    // Nothing that would hand the checker a database or storage credential.
    expect(wrapperCommands).not.toContain('CDFIR_DATABASE_URL');
    expect(wrapperCommands).not.toContain('CDFIR_S3_SECRET_ACCESS_KEY');
  });
});

describe('the backup stamp is one file, not two', () => {
  const backupScript = commandsOnly(readFileSync(repoFile('scripts/backup-postgres.sh'), 'utf8'));

  it('the reader defaults to an absolute path', () => {
    // A relative default would resolve against whatever directory cron was in.
    expect(DEFAULT_BACKUP_STAMP_FILE.startsWith('/')).toBe(true);
    expect(DEFAULT_BACKUP_STAMP_FILE.endsWith('/.last-backup')).toBe(true);
  });

  it('the writer anchors its default to the repo, not to the caller', () => {
    expect(backupScript).toContain('CDFIR_BACKUP_STAMP_FILE:-$REPO_ROOT/.last-backup');
    // The bare relative default is the bug: run as
    // `/var/www/AEGCloudDFIR/scripts/backup-postgres.sh` from root's cron, the
    // stamp went to /root and the reader never saw it again.
    expect(backupScript).not.toContain('CDFIR_BACKUP_STAMP_FILE:-.last-backup');
  });

  it('both sides honour the same override', () => {
    expect(backupScript).toContain('CDFIR_BACKUP_STAMP_FILE');
    expect(wrapperCommands).toContain('CDFIR_BACKUP_STAMP_FILE');
  });
});

describe(`${CRON_FILE} is a schedule cron will actually read`, () => {
  it('has no dot in its name, or cron ignores the file without a word', () => {
    const name = CRON_FILE.split('/').pop() ?? '';
    expect(name).not.toContain('.');
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ends with a newline, or cron ignores the last entry without a word', () => {
    expect(cron.endsWith('\n')).toBe(true);
  });

  it('runs every five minutes, as root, through the wrapper', () => {
    const entry = cron
      .split('\n')
      .find((line) => line.startsWith('*/5 '))
      ?.trim();
    expect(entry).toBeDefined();
    expect(entry).toMatch(/^\*\/5 \* \* \* \* +root +\//);
    expect(entry).toContain(WRAPPER);
  });

  it('sets PATH, because cron gives a job almost none', () => {
    // Without this, `docker` is not found and the container check fails for the
    // wrong reason — an alert that is true about nothing.
    expect(cron).toMatch(/^PATH=.*\/usr\/bin/m);
  });

  it.each(CONTAINERISED)('does not run the checker in a container (%s)', (fragment) => {
    expect(cronCommands).not.toContain(fragment);
  });
});
