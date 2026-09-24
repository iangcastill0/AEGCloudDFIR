import { spawn } from 'node:child_process';
import { basename } from 'node:path';

/**
 * The PST writer, run as a child process.
 *
 * Deliberately shaped like `soffice.ts`, which already has the right manners
 * for an external tool: a `spawn`, a hard timeout, a `spawnFn` seam so the
 * failure paths can be tested without the binary, and a `{ ok, reason }` return
 * instead of a throw. The caller's fallback is to fail the export with an
 * honest message; a crash in here would turn that into a lost job.
 *
 * The binary is `services/pst-builder/cli`, built into the worker image from
 * vendored source. It reads a job file and prints exactly one line of JSON. See
 * `services/pst-builder/UPSTREAM.md`.
 */

/** One finished PST. Each is a complete file, not a slice of a bigger one. */
export interface PstPart {
  path: string;
  name: string;
  bytes: number;
}

export interface PstbSuccess {
  ok: true;
  parts: PstPart[];
  messagesAdded: number;
  /** Attachments streamed from a spool file rather than buffered. */
  spooledAttachments: number;
  peakWorkingSetMiB: number;
  seconds: number;
}

export type PstbResult = PstbSuccess | { ok: false; reason: string };

export interface PstbOptions {
  /** Absolute path to the `pstb` binary. */
  binPath: string;
  /** Absolute path to the job JSON the binary reads. */
  jobPath: string;
  timeoutMs: number;
  /** Test seam. Production uses node:child_process spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Shape of the one JSON line the binary prints.
 *
 * Parsed defensively. A tool that printed something unexpected must produce a
 * failed export with a readable reason, never a thrown TypeError halfway
 * through an export that has already written gigabytes.
 */
interface PstbReport {
  ok?: unknown;
  fatal?: unknown;
  failures?: unknown;
  messagesAdded?: unknown;
  spooledAttachments?: unknown;
  peakWorkingSetMiB?: unknown;
  seconds?: unknown;
  parts?: unknown;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseParts(v: unknown): PstPart[] {
  if (!Array.isArray(v)) return [];
  const parts: PstPart[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.path !== 'string' || r.path === '') continue;
    parts.push({
      path: r.path,
      name: typeof r.name === 'string' && r.name !== '' ? r.name : basename(r.path),
      bytes: asNumber(r.bytes),
    });
  }
  return parts;
}

export async function buildPst(opts: PstbOptions): Promise<PstbResult> {
  const spawnImpl = opts.spawnFn ?? spawn;
  return new Promise<PstbResult>((resolve) => {
    const child = spawnImpl(opts.binPath, [opts.jobPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    // Bounded on both: a runaway process must not grow these without limit. The
    // report is one line, so 64 KiB is many times what a healthy run prints.
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 65_536) stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString('utf8');
    });

    let settled = false;
    const finish = (r: PstbResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM. A writer wedged on a malformed message will not
      // unwind politely, and the export lane is a single worker — a stuck child
      // holds every later export behind it.
      child.kill('SIGKILL');
      finish({ ok: false, reason: `pstb timed out after ${String(opts.timeoutMs)}ms` });
    }, opts.timeoutMs);

    child.on('error', (err: Error) => {
      finish({ ok: false, reason: `pstb could not be started: ${err.message}` });
    });

    child.on('close', (code: number | null) => {
      const line = stdout.trim().split('\n').at(-1) ?? '';
      let report: PstbReport | undefined;
      if (line !== '') {
        try {
          report = JSON.parse(line) as PstbReport;
        } catch {
          report = undefined;
        }
      }

      if (code !== 0) {
        // Prefer the tool's own explanation. `failures` names the messages it
        // could not add, which is what an operator needs; the exit code alone
        // says nothing about which evidence is affected.
        const failures = Array.isArray(report?.failures) ? report.failures : [];
        const detail =
          typeof report?.fatal === 'string'
            ? report.fatal
            : failures.length > 0
              ? `${String(failures.length)} message(s) failed, first: ${String(failures[0])}`
              : stderr.trim().slice(0, 300);
        return finish({
          ok: false,
          reason: `pstb exited with code ${String(code)}${detail !== '' ? `: ${detail}` : ''}`,
        });
      }

      if (report === undefined) {
        // Exit 0 with no parseable report is the "reports success, silently
        // broken" shape this repo keeps getting bitten by. It is a failure.
        return finish({ ok: false, reason: 'pstb exited 0 but printed no readable report' });
      }
      if (report.ok !== true) {
        return finish({ ok: false, reason: 'pstb exited 0 but did not report ok' });
      }

      const parts = parseParts(report.parts);
      if (parts.length === 0) {
        return finish({ ok: false, reason: 'pstb reported success but listed no PST parts' });
      }

      finish({
        ok: true,
        parts,
        messagesAdded: asNumber(report.messagesAdded),
        spooledAttachments: asNumber(report.spooledAttachments),
        peakWorkingSetMiB: asNumber(report.peakWorkingSetMiB),
        seconds: asNumber(report.seconds),
      });
    });
  });
}
