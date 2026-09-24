/**
 * The COMPILED checker, run as a real process, exactly as cron runs it.
 *
 * Why go this far when report.test.ts already covers the rules: the thing that
 * ships to the host is dist/cli.js, and the failures this repo keeps hitting all
 * look the same — reports success, silently broken. A compiled ESM entry point
 * that cannot resolve its own `./checks.js` import, or a top-level await that
 * throws before it reaches report(), passes every unit test and then does nothing
 * at 03:15 on a Sunday.
 *
 * The package's `test` script runs tsc first for this reason, so dist is present.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CHECK_FAILED, EXIT_NOT_CONFIGURED } from './report.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Nothing listens here, so the api check fails fast and deterministically. */
const CLOSED_PORT = '1';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/**
 * A local stand-in for one HTTP endpoint, recording what it was asked for.
 *
 * The switch and the public site get SEPARATE servers on purpose. Sharing one
 * made "it pinged nobody" unprovable: the site check's own request landed in the
 * same list, so the assertion passed for the wrong reason.
 */
async function startStubServer(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.statusCode = 200;
      res.end('OK');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the stub server did not report a port');
  }
  return { url: `http://127.0.0.1:${String(address.port)}`, paths };
}

function runCli(env: Record<string, string>): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    // A deliberately bare environment, the way scripts/monitor.sh hands it over:
    // PATH so `df` and `docker` resolve, and nothing else.
    const child = spawn(process.execPath, [CLI], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('the compiled checker', () => {
  it('is built before these tests run', () => {
    expect(
      existsSync(CLI),
      `${CLI} is missing. Build it first: pnpm --filter @aeg-clouddfir/monitoring run build`,
    ).toBe(true);
  });

  it('runs, reports every check, and pings /fail with a non-zero exit', async () => {
    const hc = await startStubServer();
    const site = await startStubServer();

    const run = await runCli({
      CDFIR_HEALTHCHECK_PING_URL: `${hc.url}/hc/abc123`,
      // Nothing is listening, so the api check fails. That is the point: one
      // failure has to reach the switch as /fail and as a non-zero exit.
      CDFIR_API_HOST_PORT: CLOSED_PORT,
      CDFIR_WEB_PUBLIC_URL: site.url,
      CDFIR_EXPECTED_CONTAINERS: 'a-container-that-does-not-exist',
    });

    expect(run.code).toBe(EXIT_CHECK_FAILED);
    expect(run.stdout).toContain('[FAIL] api:');
    // All six checks ran; the ping doubles as a record of what was tested.
    for (const name of ['api', 'site', 'containers', 'disk', 'backup', 'tls']) {
      expect(run.stdout).toContain(`${name}:`);
    }
    expect(hc.paths).toEqual(['/hc/abc123/fail']);
  }, 40_000);

  it('exits non-zero, and pings nothing, when no ping URL is set', async () => {
    const hc = await startStubServer();
    const site = await startStubServer();

    const run = await runCli({
      CDFIR_API_HOST_PORT: CLOSED_PORT,
      CDFIR_WEB_PUBLIC_URL: site.url,
    });

    expect(run.code).toBe(EXIT_NOT_CONFIGURED);
    expect(run.stdout).toContain('NOBODY WAS NOTIFIED');
    // It still did the work and still said so: this is a misconfiguration, not a
    // crash, and the operator sees the findings on the very first manual run.
    expect(run.stdout).toContain('[FAIL] api:');
    // The site WAS checked, so the empty list below means the ping really was the
    // only thing that did not happen.
    expect(site.paths).toEqual(['/']);
    expect(hc.paths).toEqual([]);
  }, 40_000);
});
