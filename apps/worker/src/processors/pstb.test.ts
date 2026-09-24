import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildPst } from './pstb.js';

/**
 * The spawn wrapper. Mirrors `soffice.test.ts`: a fake child process, so every
 * failure path is exercised without the binary being present.
 *
 * The cases that matter are the dishonest ones — exit 0 with nothing useful
 * printed. This repo's recurring fault is "reports success, silently broken",
 * and for an export that would mean handing over a PST that is not there.
 */

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => boolean;
}

function fakeSpawn(script: (child: FakeChild) => void): {
  spawnFn: never;
  killed: string[];
} {
  const killed: string[] = [];
  const spawnFn = ((): FakeChild => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal?: string): boolean => {
      killed.push(signal ?? 'SIGTERM');
      return true;
    };
    setImmediate(() => script(child));
    return child;
  }) as unknown as never;
  return { spawnFn, killed };
}

const OPTS = { binPath: '/usr/local/bin/pstb', jobPath: '/scratch/job.json', timeoutMs: 1000 };

const GOOD_REPORT = JSON.stringify({
  ok: true,
  messagesAdded: 3,
  spooledAttachments: 1,
  peakWorkingSetMiB: 259,
  seconds: 1.5,
  parts: [
    { path: '/scratch/out/export.pst', name: 'export.pst', bytes: 525_312 },
    { path: '/scratch/out/export-002.pst', name: 'export-002.pst', bytes: 271_360 },
  ],
});

describe('buildPst', () => {
  it('returns the parts the writer reported', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.write(`${GOOD_REPORT}\n`);
      child.emit('close', 0);
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts).toHaveLength(2);
    expect(result.parts[1]?.name).toBe('export-002.pst');
    expect(result.messagesAdded).toBe(3);
    expect(result.peakWorkingSetMiB).toBe(259);
  });

  it('kills the process and reports a timeout rather than hanging', async () => {
    vi.useFakeTimers();
    try {
      // A child that never closes. Without the timeout this promise never
      // settles, and the single export lane is held forever.
      const { spawnFn, killed } = fakeSpawn(() => undefined);
      const pending = buildPst({ ...OPTS, timeoutMs: 500, spawnFn });
      await vi.advanceTimersByTimeAsync(600);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('timed out after 500ms');
      // SIGKILL, not SIGTERM: a writer wedged on malformed input does not
      // unwind politely.
      expect(killed).toEqual(['SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when the binary is missing', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.emit('error', new Error('spawn /usr/local/bin/pstb ENOENT'));
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('could not be started');
    expect(result.reason).toContain('ENOENT');
  });

  it('names the failed messages, not just the exit code', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.write(
        `${JSON.stringify({
          ok: false,
          failures: ['/scratch/native/abc.eml: FormatException: bad header'],
        })}\n`,
      );
      child.emit('close', 1);
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Which evidence is affected is the thing an operator needs.
    expect(result.reason).toContain('bad header');
  });

  it('treats exit 0 with no readable report as a failure', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.write('Welcome to pstb!\n');
      child.emit('close', 0);
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('printed no readable report');
  });

  it('treats exit 0 with zero parts as a failure', async () => {
    // The precise "reports success, silently broken" shape: the tool is happy
    // and there is no PST. Accepting this would mark the export ready with
    // nothing to download.
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.write(`${JSON.stringify({ ok: true, parts: [] })}\n`);
      child.emit('close', 0);
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('listed no PST parts');
  });

  it('treats exit 0 without ok:true as a failure', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.write(`${JSON.stringify({ parts: [{ path: '/x.pst', bytes: 1 }] })}\n`);
      child.emit('close', 0);
    });
    const result = await buildPst({ ...OPTS, spawnFn });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not report ok');
  });
});
