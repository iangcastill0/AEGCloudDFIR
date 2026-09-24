/**
 * The reporting half of the dead-man's switch, tested against a REAL HTTP server
 * rather than a mocked fetch.
 *
 * Why a real server: what has to be right here is the thing on the wire — which
 * URL, which method, and what the body says. A stubbed fetch proves the code
 * calls something; it cannot notice `…/uuid//fail`, which is a 404 that looks
 * exactly like a delivered alert.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { summarize, type CheckResult } from './checks.js';
import {
  EXIT_CHECK_FAILED,
  EXIT_NOT_CONFIGURED,
  EXIT_OK,
  EXIT_PING_FAILED,
  pingTarget,
  report,
} from './report.js';

interface Ping {
  method: string;
  path: string;
  body: string;
}

interface Switchboard {
  /** Base ping URL, shaped like healthchecks.io's. */
  url: string;
  pings: Ping[];
  server: Server;
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

async function startSwitchboard(responseStatus = 200): Promise<Switchboard> {
  const pings: Ping[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      pings.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = responseStatus;
      res.end('OK');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not report a port');
  }
  return { url: `http://127.0.0.1:${String(address.port)}/hc/abc123`, pings, server };
}

function collector(): { write: (text: string) => void; text: () => string } {
  let buffer = '';
  return {
    write: (text: string) => {
      buffer += text;
    },
    text: () => buffer,
  };
}

const ok: CheckResult = { name: 'api', status: 'ok', detail: 'database and object storage ok' };
const nearlyFull: CheckResult = {
  name: 'disk',
  status: 'warn',
  detail: 'root filesystem 82% used',
};
const backupMissed: CheckResult = {
  name: 'backup',
  status: 'fail',
  detail: 'newest backup is 41.2 hours old',
};

describe('report', () => {
  it('pings /fail and exits non-zero when a check failed', async () => {
    const sw = await startSwitchboard();
    const out = collector();

    const code = await report(summarize([ok, backupMissed]), {
      pingUrl: sw.url,
      write: out.write,
    });

    expect(code).toBe(EXIT_CHECK_FAILED);
    expect(code).not.toBe(0);
    expect(sw.pings).toHaveLength(1);
    expect(sw.pings[0]?.path).toBe('/hc/abc123/fail');
    expect(sw.pings[0]?.method).toBe('POST');
    // The body is what lands in the alert email, so it has to say what broke.
    expect(sw.pings[0]?.body).toContain('backup');
    expect(sw.pings[0]?.body).toContain('41.2 hours old');
  });

  it('pings the plain URL and exits 0 when nothing failed', async () => {
    const sw = await startSwitchboard();
    const out = collector();

    const code = await report(summarize([ok]), { pingUrl: sw.url, write: out.write });

    expect(code).toBe(EXIT_OK);
    expect(sw.pings[0]?.path).toBe('/hc/abc123');
  });

  it('does not ping /fail for a warning', async () => {
    // A disk at 82% must not page. An alert for something you cannot act on today
    // teaches the operator to ignore alerts, and then the real one is ignored too.
    const sw = await startSwitchboard();
    const out = collector();

    const code = await report(summarize([ok, nearlyFull]), { pingUrl: sw.url, write: out.write });

    expect(code).toBe(EXIT_OK);
    expect(sw.pings[0]?.path).toBe('/hc/abc123');
  });

  it('strips a trailing slash, so the alert does not become a 404', async () => {
    // A pasted URL very often ends in "/". "…/abc123//fail" is a 404 that looks
    // identical to a delivered alert from this side.
    const sw = await startSwitchboard();
    const out = collector();

    await report(summarize([backupMissed]), { pingUrl: `${sw.url}/`, write: out.write });

    expect(sw.pings[0]?.path).toBe('/hc/abc123/fail');
  });

  it('does not report success when no ping URL is configured', async () => {
    // The dangerous case. An unconfigured checker that exits 0 looks installed
    // and tells nobody, which removes the reason to ever look at it.
    const out = collector();
    const never: typeof fetch = () => {
      throw new Error('report() must not attempt a ping with no URL');
    };

    const code = await report(summarize([ok]), { pingUrl: '', write: out.write, fetchImpl: never });

    expect(code).toBe(EXIT_NOT_CONFIGURED);
    expect(code).not.toBe(0);
    expect(out.text()).toContain('CDFIR_HEALTHCHECK_PING_URL');
    expect(out.text()).toContain('NOBODY WAS NOTIFIED');
    // It still ran and still said what it found — it is not a crash.
    expect(out.text()).toContain('database and object storage ok');
  });

  it('treats a blank ping URL the same as a missing one', async () => {
    const out = collector();
    const never: typeof fetch = () => {
      throw new Error('report() must not attempt a ping with a blank URL');
    };

    const code = await report(summarize([ok]), {
      pingUrl: '   \n',
      write: out.write,
      fetchImpl: never,
    });

    expect(code).toBe(EXIT_NOT_CONFIGURED);
  });

  it('does not report success when the switch rejects the ping', async () => {
    // A wrong URL answers 404. Everything else here would look perfect.
    const sw = await startSwitchboard(404);
    const out = collector();

    const code = await report(summarize([ok]), { pingUrl: sw.url, write: out.write });

    expect(code).toBe(EXIT_PING_FAILED);
    expect(out.text()).toContain('404');
    expect(out.text()).toContain('NOT ACCEPTED');
  });

  it('does not report success when the switch cannot be reached', async () => {
    const sw = await startSwitchboard();
    const url = sw.url;
    await new Promise<void>((resolve) => {
      sw.server.close(() => {
        resolve();
      });
    });
    const out = collector();

    const code = await report(summarize([ok]), { pingUrl: url, write: out.write, timeoutMs: 2000 });

    expect(code).toBe(EXIT_PING_FAILED);
    expect(out.text()).toContain('could not be delivered');
  });

  it('still leads with the check failure when the ping also fails', async () => {
    // Losing the ping is already covered: the switch alerts on silence. The
    // failing check is the thing a human needs to read first.
    const sw = await startSwitchboard();
    const url = sw.url;
    await new Promise<void>((resolve) => {
      sw.server.close(() => {
        resolve();
      });
    });
    const out = collector();

    const code = await report(summarize([backupMissed]), {
      pingUrl: url,
      write: out.write,
      timeoutMs: 2000,
    });

    expect(code).toBe(EXIT_CHECK_FAILED);
  });

  it('never throws, whatever the switch does', async () => {
    const out = collector();
    const explodes: typeof fetch = () => Promise.reject(new Error('socket hang up'));

    await expect(
      report(summarize([ok]), {
        pingUrl: 'https://example.invalid/x',
        write: out.write,
        fetchImpl: explodes,
      }),
    ).resolves.toBe(EXIT_PING_FAILED);
  });

  it('gives every outcome its own exit code', () => {
    // Four different answers to "what happened", readable in a log or cron mail.
    expect(new Set([EXIT_OK, EXIT_CHECK_FAILED, EXIT_NOT_CONFIGURED, EXIT_PING_FAILED]).size).toBe(
      4,
    );
    expect(EXIT_OK).toBe(0);
    for (const code of [EXIT_CHECK_FAILED, EXIT_NOT_CONFIGURED, EXIT_PING_FAILED]) {
      expect(code).toBeGreaterThan(0);
    }
  });
});

describe('pingTarget', () => {
  it('appends /fail only for an alert', () => {
    expect(pingTarget('https://hc-ping.com/abc', false)).toBe('https://hc-ping.com/abc');
    expect(pingTarget('https://hc-ping.com/abc', true)).toBe('https://hc-ping.com/abc/fail');
  });

  it('tolerates the slashes and spaces a pasted URL arrives with', () => {
    expect(pingTarget('https://hc-ping.com/abc///', true)).toBe('https://hc-ping.com/abc/fail');
    expect(pingTarget('  https://hc-ping.com/abc  ', false)).toBe('https://hc-ping.com/abc');
  });
});
