/**
 * Executable tests for the deploy-time migrate step.
 *
 * These live here, in the package that already owns "things that run on the
 * host", for two reasons that are not convenience:
 *
 *  - the backup guard in scripts/migrate.sh has to agree with
 *    BACKUP_MAX_AGE_HOURS, the number this package's monitor uses for the same
 *    stamp file. Two thresholds for one fact is how an operator ends up with a
 *    deploy that refuses while the monitor says backups are healthy.
 *  - packages/monitoring/src/host.test.ts already reads scripts/*.sh from the
 *    repo root, and turbo.json already lists those scripts as global
 *    dependencies so a change to them busts the test cache.
 *
 * They RUN the scripts rather than reading them. `bash -n` is not a test: it
 * accepts an unterminated heredoc, and it cannot tell you that a failed
 * migration still restarted the containers. So `docker` and `curl` are replaced
 * by stubs on PATH that record every call, and the assertions are about what the
 * real script actually did and in what order.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKUP_MAX_AGE_HOURS } from './checks.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SH = join(REPO, 'scripts/migrate.sh');
const DEPLOY_SH = join(REPO, 'scripts/deploy.sh');
const DEPLOY_STAGING_SH = join(REPO, 'scripts/deploy-staging.sh');

/**
 * Fake docker.
 *
 * Records every invocation so the tests can assert ORDER, and answers the two
 * prisma calls from files the test writes.
 *
 * `migrate status` always exits 1 here, on purpose. The real command does too
 * whenever anything is pending, so a script that reads its exit code instead of
 * its output would pass a friendlier stub and fail in production.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *"prisma migrate status"*)
    n=$(( $(cat "$FAKE_DIR/status.n" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$n" > "$FAKE_DIR/status.n"
    if [ -f "$FAKE_DIR/status.$n" ]; then
      cat "$FAKE_DIR/status.$n"
    else
      cat "$FAKE_DIR/status.last" 2>/dev/null || true
    fi
    exit 1
    ;;
  *"prisma migrate deploy"*)
    cat "$FAKE_DIR/deploy.out" 2>/dev/null || true
    exit "$(cat "$FAKE_DIR/deploy.exit" 2>/dev/null || echo 0)"
    ;;
esac
exit 0
`;

/** Fake curl: /readyz is healthy and the web root answers 200. */
const CURL_STUB = `#!/usr/bin/env bash
case "$*" in
  *readyz*) printf '{"status":"ok"}' ;;
  *http_code*) printf '200' ;;
esac
exit 0
`;

const PRISMA_PENDING = `Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "cdfir", schema "public" at "postgres:5432"

16 migrations found in prisma/migrations

Following migrations have not yet been applied:
20260922000013_export_parts
20260922000014_object_missing
20260922140000_self_serve_tenancy

To apply migrations in production run prisma migrate deploy.
`;

const PRISMA_UP_TO_DATE = `Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "cdfir", schema "public" at "postgres:5432"

16 migrations found in prisma/migrations

Database schema is up to date!
`;

const PRISMA_ALREADY_FAILED = `Prisma schema loaded from prisma/schema.prisma

Following migration have failed:
20260922140000_self_serve_tenancy

The failed migration(s) can be marked as rolled back or applied.
`;

const PRISMA_NO_ENV_VAR = `error: Environment variable not found: CDFIR_DATABASE_MIGRATION_URL.
  -->  schema.prisma:21
`;

/** What a database the script cannot reach looks like: not a verdict either way. */
const PRISMA_UNREACHABLE = `Error: P1001: Can't reach database server at \`postgres:5432\`
`;

interface Fake {
  /** Scratch directory the stubs read their answers from. */
  dir: string;
  /** Every docker invocation, one per line, in order. */
  log: string;
  envFile: string;
  composeFile: string;
  stamp: string;
  bin: string;
  root: string;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeStub(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/**
 * A throwaway repo root with stub binaries, an .env, and a compose file.
 *
 * The compose file's contents never matter: docker is stubbed, so nothing parses
 * it. It has to EXIST because both scripts refuse to run without it, which is
 * itself worth keeping true.
 */
function makeFake(options: { stampHours?: number | 'missing' | 'garbage' } = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), 'cdfir-migrate-'));
  const dir = join(root, 'fake');
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'infra', 'compose'), { recursive: true });
  mkdirSync(join(root, 'packages', 'monitoring', 'dist'), { recursive: true });

  writeStub(join(bin, 'docker'), DOCKER_STUB);
  writeStub(join(bin, 'curl'), CURL_STUB);

  const envFile = join(root, '.env');
  writeFileSync(
    envFile,
    ['CDFIR_IMAGE_TAG=sha-old00', 'CDFIR_API_HOST_PORT=4000', 'CDFIR_WEB_HOST_PORT=3000', ''].join(
      '\n',
    ),
  );

  const composeFile = join(root, 'infra', 'compose', 'docker-compose.yml');
  writeFileSync(composeFile, 'name: cdfir\n');

  const stamp = join(root, '.last-backup');
  const when = options.stampHours ?? 2;
  if (when === 'garbage') writeFileSync(stamp, 'not-a-date\n');
  else if (when !== 'missing') writeFileSync(stamp, `${hoursAgo(when)}\n`);

  // Default: something to apply, and the confirming status after a successful
  // apply says the schema is now up to date.
  writeFileSync(join(dir, 'status.1'), PRISMA_PENDING);
  writeFileSync(join(dir, 'status.last'), PRISMA_UP_TO_DATE);

  return { dir, log: join(root, 'docker.log'), envFile, composeFile, stamp, bin, root };
}

interface Run {
  code: number;
  /** stdout and stderr together: the operator reads one stream. */
  output: string;
  /** Every docker invocation, in order. */
  docker: string[];
}

function run(script: string, argv: string[], f: Fake): Run {
  const r = spawnSync('bash', [script, ...argv], {
    encoding: 'utf8',
    cwd: f.root,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH ?? ''}`,
      FAKE_DIR: f.dir,
      FAKE_LOG: f.log,
      CDFIR_BACKUP_STAMP_FILE: f.stamp,
    },
  });
  let docker: string[] = [];
  try {
    docker = readFileSync(f.log, 'utf8').split('\n').filter(Boolean);
  } catch {
    docker = [];
  }
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, docker };
}

function migrate(f: Fake, extra: string[] = []): Run {
  return run(
    MIGRATE_SH,
    ['sha-new11', '--env-file', f.envFile, '--compose-file', f.composeFile, ...extra],
    f,
  );
}

/** Copies a deploy script and the migrate step it calls into the fake repo. */
function installDeployScript(f: Fake, source: string): string {
  const target = join(f.root, 'scripts', 'deploy.sh');
  writeStub(target, readFileSync(source, 'utf8'));
  writeStub(join(f.root, 'scripts', 'migrate.sh'), readFileSync(MIGRATE_SH, 'utf8'));
  return target;
}

const indexOfCall = (calls: string[], re: RegExp): number => calls.findIndex((c) => re.test(c));
const applied = (r: Run): boolean => r.docker.some((c) => c.includes('prisma migrate deploy'));
/** `up -d` of the APP services. migrate.sh starts the database, which is not that. */
const startedApp = (r: Run): boolean => r.docker.some((c) => /up -d .*\bweb\b/.test(c));

describe('the backup guard refuses to change a schema it cannot restore', () => {
  it('applies when the last verified backup is recent', () => {
    const f = makeFake({ stampHours: 2 });
    const r = migrate(f);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(true);
    expect(r.output).toContain('last verified backup');
  });

  it('refuses when the stamp is stale, and applies nothing', () => {
    const f = makeFake({ stampHours: BACKUP_MAX_AGE_HOURS + 1 });
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain(`the limit is ${BACKUP_MAX_AGE_HOURS}h`);
    // The refusal has to say what to do, or it is just a locked door.
    expect(r.output).toContain('./scripts/backup-postgres.sh');
    expect(r.output).toContain('--skip-backup-check');
    expect(r.output).toContain('NOTHING was restarted');
  });

  it('refuses when there is no stamp at all', () => {
    const f = makeFake({ stampHours: 'missing' });
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('no verified backup found');
  });

  it('refuses when the stamp cannot be read as a date', () => {
    // A half-written stamp must not read as "very old" or as "now". Both have
    // happened to date parsers; only one of them is safe.
    const f = makeFake({ stampHours: 'garbage' });
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('cannot read the backup stamp');
  });

  it('accepts a stamp just inside the window', () => {
    const f = makeFake({ stampHours: BACKUP_MAX_AGE_HOURS - 1 });
    expect(migrate(f).code).toBe(0);
  });

  it('can be overridden for an emergency, and says so loudly', () => {
    const f = makeFake({ stampHours: BACKUP_MAX_AGE_HOURS + 100 });
    const r = migrate(f, ['--skip-backup-check']);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(true);
    expect(r.output).toContain('--skip-backup-check: changing the schema WITHOUT');
  });

  it('does not check a database marked expendable, and does not cry wolf about it', () => {
    // Staging. scripts/backup-postgres.sh dumps PRODUCTION, so staging has no
    // stamp of its own; gating it on production's would always pass, for the
    // wrong reason.
    const f = makeFake({ stampHours: 'missing' });
    const r = migrate(f, ['--expendable-database']);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(true);
    expect(r.output).toContain('expendable');
    expect(r.output).not.toContain('WITHOUT');
  });

  it('never blocks a deploy that changes no schema', () => {
    // The reason this guard will still be switched on in six months. A check that
    // fires on every deploy is a check operators learn to route around, and then
    // it is not there for the deploy that needed it.
    const f = makeFake({ stampHours: 'missing' });
    writeFileSync(join(f.dir, 'status.1'), PRISMA_UP_TO_DATE);
    const r = migrate(f);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('nothing to apply');
    expect(r.output).not.toContain('no verified backup');
  });

  it('uses the same threshold as the monitor that reads the same stamp', () => {
    const declared = /^BACKUP_MAX_AGE_HOURS=(\d+)$/m.exec(readFileSync(MIGRATE_SH, 'utf8'));
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(BACKUP_MAX_AGE_HOURS);
  });

  it('takes the threshold from nowhere but itself', () => {
    // An env-readable limit is a limit that gets widened in one .env and then
    // nobody knows which host guards what.
    const source = readFileSync(MIGRATE_SH, 'utf8');
    expect(source).not.toMatch(/BACKUP_MAX_AGE_HOURS="?\$\{?CDFIR/);
  });
});

describe('order: the schema changes before any new code serves traffic', () => {
  it('pulls the new image, then asks, then applies', () => {
    const f = makeFake();
    const r = migrate(f);
    const pull = indexOfCall(r.docker, /compose .*\bpull\b/);
    const ask = indexOfCall(r.docker, /prisma migrate status/);
    const apply = indexOfCall(r.docker, /prisma migrate deploy/);
    expect(pull).toBeGreaterThanOrEqual(0);
    // Pull first or the migration files are the OLD ones, and the whole step
    // reports success having applied yesterday's schema.
    expect(pull).toBeLessThan(ask);
    expect(ask).toBeLessThan(apply);
  });

  it('runs a one-off container, never exec into the api that is already running', () => {
    const f = makeFake();
    const r = migrate(f);
    const prismaCalls = r.docker.filter((c) => c.includes('prisma migrate'));
    expect(prismaCalls.length).toBeGreaterThan(0);
    for (const call of prismaCalls) {
      expect(call).toContain('run --rm');
      // `docker exec` would reach the OLD image, with the OLD migration files.
      expect(call).not.toMatch(/(^| )exec /);
    }
  });

  it('stops dead when the migration fails, and restarts nothing', () => {
    const f = makeFake();
    writeFileSync(join(f.dir, 'deploy.exit'), '1');
    writeFileSync(join(f.dir, 'deploy.out'), 'ERROR: column "billingStatus" already exists\n');
    const r = migrate(f);
    expect(r.code).toBe(1);
    expect(r.output).toContain('billingStatus');
    expect(r.output).toContain('NOTHING was restarted');
    expect(startedApp(r)).toBe(false);
  });

  it('does not believe its own exit code', () => {
    // Every fault on this deployment looked the same: reports success, silently
    // broken. So a "successful" apply is followed by asking the database again.
    const f = makeFake();
    writeFileSync(join(f.dir, 'status.last'), PRISMA_PENDING);
    const r = migrate(f);
    expect(r.code).toBe(1);
    expect(r.output).toContain('still not');
    expect(startedApp(r)).toBe(false);
  });
});

describe('it refuses rather than guessing', () => {
  it('names a migration prisma has already recorded as failed', () => {
    const f = makeFake();
    writeFileSync(join(f.dir, 'status.1'), PRISMA_ALREADY_FAILED);
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('recorded as FAILED');
    expect(r.output).toContain('migrate resolve');
    expect(r.output).toContain('20260922140000_self_serve_tenancy');
  });

  it('explains a missing CDFIR_DATABASE_MIGRATION_URL instead of passing on prisma error text', () => {
    const f = makeFake();
    writeFileSync(join(f.dir, 'status.1'), PRISMA_NO_ENV_VAR);
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('cdfir_migrator');
    expect(r.output).toContain('CDFIR_DB_PASSWORD');
  });

  it('stops when it cannot tell whether anything is pending', () => {
    // An unreachable database, a wrong role, or a changed prisma message must
    // never read as "nothing to do" — that is the outage, dressed as a green tick.
    const f = makeFake();
    writeFileSync(join(f.dir, 'status.1'), PRISMA_UNREACHABLE);
    const r = migrate(f);
    expect(r.code).toBe(70);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('Refusing to guess');
  });
});

describe('--status shows what would be applied and changes nothing', () => {
  it('lists the pending migrations without applying them', () => {
    const f = makeFake();
    const r = migrate(f, ['--status']);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(false);
    expect(r.output).toContain('20260922140000_self_serve_tenancy');
    expect(r.output).toContain('3 migration(s) pending');
    expect(r.output).toContain('Nothing was changed');
  });

  it('writes no file and starts no container', () => {
    const f = makeFake();
    const before = readFileSync(f.envFile, 'utf8');
    const r = migrate(f, ['--status']);
    expect(readFileSync(f.envFile, 'utf8')).toBe(before);
    expect(r.docker.some((c) => c.includes('up -d'))).toBe(false);
  });

  it('reports the backup verdict, so the refusal is not a surprise at deploy time', () => {
    const f = makeFake({ stampHours: BACKUP_MAX_AGE_HOURS + 5 });
    const r = migrate(f, ['--status']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('would REFUSE');
  });
});

describe('scripts/deploy.sh puts the migrate step in the right place', () => {
  it('migrates before it starts the app services', () => {
    const f = makeFake({ stampHours: 1 });
    const script = installDeployScript(f, DEPLOY_SH);
    const r = run(script, ['sha-new11'], f);
    expect(r.code).toBe(0);
    const apply = indexOfCall(r.docker, /prisma migrate deploy/);
    const start = indexOfCall(r.docker, /up -d .*\bweb\b/);
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(apply).toBeLessThan(start);
  });

  it('leaves the previous version serving when the migrate step refuses', () => {
    const f = makeFake({ stampHours: 'missing' });
    const script = installDeployScript(f, DEPLOY_SH);
    const r = run(script, ['sha-new11'], f);
    expect(r.code).not.toBe(0);
    expect(startedApp(r)).toBe(false);
    expect(applied(r)).toBe(false);
    // And the recorded tag goes back, so a later plain `up -d` cannot bring the
    // half-deployed version up on its own.
    expect(readFileSync(f.envFile, 'utf8')).toContain('CDFIR_IMAGE_TAG=sha-old00');
  });

  it('a dry run applies nothing and writes nothing', () => {
    const f = makeFake();
    const script = installDeployScript(f, DEPLOY_SH);
    const before = readFileSync(f.envFile, 'utf8');
    const r = run(script, ['sha-new11', '--dry-run'], f);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(false);
    expect(startedApp(r)).toBe(false);
    expect(readFileSync(f.envFile, 'utf8')).toBe(before);
    expect(r.output).toContain('20260922140000_self_serve_tenancy');
  });

  it('accepts the emergency override and hands it to the migrate step', () => {
    const f = makeFake({ stampHours: BACKUP_MAX_AGE_HOURS + 9 });
    const script = installDeployScript(f, DEPLOY_SH);
    const r = run(script, ['sha-new11', '--skip-backup-check'], f);
    expect(r.code).toBe(0);
    expect(applied(r)).toBe(true);
  });
});

describe('scripts/deploy-staging.sh gets the same treatment', () => {
  /** Staging reads .env.staging and a differently named compose file. */
  function makeStagingFake(): Fake {
    const f = makeFake({ stampHours: 'missing' });
    const envFile = join(f.root, '.env.staging');
    writeFileSync(
      envFile,
      [
        'CDFIR_IMAGE_TAG=sha-old00',
        'CDFIR_API_HOST_PORT=4100',
        'CDFIR_WEB_HOST_PORT=3100',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dirname(f.composeFile), 'docker-compose.staging.yml'), 'name: cdfir\n');
    return { ...f, envFile };
  }

  it('migrates before it starts the app services', () => {
    const f = makeStagingFake();
    const target = join(f.root, 'scripts', 'deploy-staging.sh');
    writeStub(target, readFileSync(DEPLOY_STAGING_SH, 'utf8'));
    writeStub(join(f.root, 'scripts', 'migrate.sh'), readFileSync(MIGRATE_SH, 'utf8'));

    const r = run(target, ['sha-new11'], f);
    expect(r.code).toBe(0);
    const apply = indexOfCall(r.docker, /prisma migrate deploy/);
    const start = indexOfCall(r.docker, /up -d .*\bweb-staging\b/);
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(apply).toBeLessThan(start);
    // It has no backup of its own, and says that rather than warning about one.
    expect(r.output).toContain('expendable');
  });

  it('points the migrate step at staging, never at production', () => {
    // A staging deploy that migrated production's database would be the worst
    // possible version of this change.
    const source = readFileSync(DEPLOY_STAGING_SH, 'utf8');
    expect(source).toContain('--api-service api-staging');
    expect(source).toContain('--db-service postgres-staging');
    expect(source).toContain('--env-file "$ENV_FILE"');
    expect(source).not.toMatch(/--api-service api\s/);
  });
});
