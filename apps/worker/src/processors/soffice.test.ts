import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { convertToPlainText, isConvertible } from './soffice.js';

/**
 * A fake child process. `behaviour` decides what the spawned command does:
 * writes output and exits cleanly, exits non-zero, fails to start, or hangs.
 */
function fakeSpawn(behaviour: {
  /** What soffice writes into outdir (stage 1). */
  writes?: (outdir: string) => Promise<void>;
  /** What pdftotext writes to its output path (stage 2). */
  pdfText?: string | null;
  exitCode?: number | null;
  pdftotextExitCode?: number | null;
  startError?: Error;
  hang?: boolean;
  stderr?: string;
}) {
  const killed: string[] = [];
  const fn = vi.fn((_cmd: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: Readable | null;
      kill: (sig: string) => void;
    };
    const stderr = new Readable({ read() {} });
    child.stderr = stderr;
    child.kill = (sig: string) => {
      killed.push(sig);
      // A killed process still emits close; the timeout must have already won.
      queueMicrotask(() => child.emit('close', null));
    };

    const isPdftotext = _cmd === 'pdftotext';
    const outdirIdx = args.indexOf('--outdir');
    const outdir = outdirIdx >= 0 ? String(args[outdirIdx + 1]) : '';
    // pdftotext's last argument is the destination text file.
    const textOut = isPdftotext ? String(args[args.length - 1]) : '';

    queueMicrotask(() => {
      void (async () => {
        if (behaviour.startError) {
          child.emit('error', behaviour.startError);
          return;
        }
        if (behaviour.stderr !== undefined) stderr.push(Buffer.from(behaviour.stderr));
        stderr.push(null);
        if (behaviour.hang === true) return; // never emits close
        if (isPdftotext) {
          if (behaviour.pdfText !== null && behaviour.pdfText !== undefined) {
            await writeFile(textOut, behaviour.pdfText);
          }
        } else if (behaviour.writes) {
          await behaviour.writes(outdir);
        }
        // Node emits 'close' only after the stdio streams have drained. Yield a
        // macrotask so the stderr 'data' handler has run, or the fake would
        // deliver an exit without the diagnostics a real one carries.
        await new Promise((r) => setTimeout(r, 0));
        child.emit(
          'close',
          isPdftotext ? (behaviour.pdftotextExitCode ?? 0) : (behaviour.exitCode ?? 0),
        );
      })();
    });
    return child as never;
  });
  return { fn: fn as never, calls: fn, killed };
}

const OPTS = { timeoutMs: 500, maxTextBytes: 1024 * 1024 };

describe('isConvertible', () => {
  it.each([
    ['application/x-mspublisher', 'a.pub'],
    ['application/vnd.visio', 'a.vsd'],
    ['application/wordperfect', 'a.wpd'],
  ])('accepts %s, which Tika commonly declines', (mime, name) => {
    expect(isConvertible(mime, name)).toBe(true);
  });

  it('accepts on extension when the MIME type is generic', () => {
    // Uploads frequently arrive as application/octet-stream.
    expect(isConvertible('application/octet-stream', 'plans.pub')).toBe(true);
  });

  it('tolerates a MIME type with parameters', () => {
    expect(isConvertible('application/x-mspublisher; charset=binary', 'a.pub')).toBe(true);
  });

  it.each([
    ['image/jpeg', 'photo.jpg'],
    ['application/zip', 'archive.zip'],
    ['application/x-msdownload', 'setup.exe'],
    ['application/pdf', 'doc.pdf'],
  ])('declines %s — spawning LibreOffice for it would waste seconds per item', (mime, name) => {
    expect(isConvertible(mime, name)).toBe(false);
  });

  it('declines a file with no extension and an unknown type', () => {
    expect(isConvertible('application/octet-stream', 'noextension')).toBe(false);
  });
});

describe('convertToPlainText', () => {
  it('returns the text pdftotext recovered from the rendered PDF', async () => {
    const spawn = fakeSpawn({
      writes: async (outdir) => writeFile(`${outdir}/input.pdf`, '%PDF-1.4'),
      pdfText: 'Board meeting agenda\nQ3 budget',
    });
    const result = await convertToPlainText(
      Buffer.from('binary'),
      'application/x-mspublisher',
      'a.pub',
      {
        ...OPTS,
        spawnFn: spawn.fn,
      },
    );
    expect(result).toEqual({ ok: true, text: 'Board meeting agenda\nQ3 budget' });
  });

  it('runs with a private user profile so concurrent conversions cannot collide', async () => {
    const spawn = fakeSpawn({
      writes: async (outdir) => writeFile(`${outdir}/input.pdf`, '%PDF'),
      pdfText: 'x',
    });
    await convertToPlainText(Buffer.from('b'), 'application/x-mspublisher', 'a.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    // LibreOffice serialises on a shared profile; the worker runs many jobs at
    // once, so a shared one would block or fail conversions against each other.
    const args = spawn.calls.mock.calls[0]![1] as string[];
    const profile = args.find((a) => a.startsWith('-env:UserInstallation='));
    expect(profile).toBeDefined();
    expect(profile).toContain('/profile');
    expect(args).toContain('--headless');
    // PDF, not txt:Text — the text filter is a Writer filter and silently
    // produces nothing for a document that imports into Draw.
    expect(args).toContain('pdf');
    expect(args).not.toContain('txt:Text');
  });

  it('runs pdftotext on the PDF that LibreOffice produced', async () => {
    const spawn = fakeSpawn({
      writes: async (outdir) => writeFile(`${outdir}/input.pdf`, '%PDF'),
      pdfText: 'recovered',
    });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      { ...OPTS, spawnFn: spawn.fn },
    );
    expect(result).toEqual({ ok: true, text: 'recovered' });
    expect(spawn.calls.mock.calls[0]![0]).toBe('soffice');
    expect(spawn.calls.mock.calls[1]![0]).toBe('pdftotext');
  });

  it('fails when LibreOffice exits cleanly but writes no PDF', async () => {
    // Exactly what a direct text conversion did for a real .pub: exit 0, no
    // file. Absence of output is the only reliable failure signal.
    const spawn = fakeSpawn({ exitCode: 0 });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      { ...OPTS, spawnFn: spawn.fn },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no PDF/);
    // pdftotext must not run when there is nothing to read.
    expect(spawn.calls.mock.calls.some((c) => c[0] === 'pdftotext')).toBe(false);
  });

  it('gives each invocation a DIFFERENT profile directory', async () => {
    const spawn = fakeSpawn({
      writes: async (o) => writeFile(`${o}/input.pdf`, '%PDF'),
      pdfText: 'x',
    });
    await convertToPlainText(Buffer.from('a'), 'application/x-mspublisher', 'a.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    await convertToPlainText(Buffer.from('b'), 'application/x-mspublisher', 'b.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    const profileOf = (i: number) =>
      (spawn.calls.mock.calls[i]![1] as string[]).find((a) =>
        a.startsWith('-env:UserInstallation='),
      );
    expect(profileOf(0)).not.toBe(profileOf(1));
  });

  it('kills a hung conversion with SIGKILL rather than holding the job forever', async () => {
    const spawn = fakeSpawn({ hang: true });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      { ...OPTS, timeoutMs: 50, spawnFn: spawn.fn },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/);
    // SIGTERM is ignored by a wedged soffice, so politeness would not free it.
    expect(spawn.killed).toContain('SIGKILL');
  });

  it('reports a non-zero exit without throwing', async () => {
    const spawn = fakeSpawn({ exitCode: 1, stderr: 'Error: no filter for this format' });
    const result = await convertToPlainText(Buffer.from('b'), 'application/vnd.visio', 'a.vsd', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('exited with code 1');
      expect(result.reason).toContain('no filter');
    }
  });

  it('reports a missing binary rather than crashing the job', async () => {
    const spawn = fakeSpawn({ startError: new Error('spawn soffice ENOENT') });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      {
        ...OPTS,
        spawnFn: spawn.fn,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not be started/);
  });

  it('treats an empty conversion as a failure, not as extracted text', async () => {
    // Recording empty text would mark the item searched when nothing indexed.
    const spawn = fakeSpawn({
      writes: async (o) => writeFile(`${o}/input.pdf`, '%PDF'),
      pdfText: '   \n\t ',
    });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      {
        ...OPTS,
        spawnFn: spawn.fn,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no extractable text/);
  });

  it('caps the text it reads back', async () => {
    const spawn = fakeSpawn({
      writes: async (o) => writeFile(`${o}/input.pdf`, '%PDF'),
      pdfText: 'A'.repeat(5000),
    });
    const result = await convertToPlainText(
      Buffer.from('b'),
      'application/x-mspublisher',
      'a.pub',
      {
        ...OPTS,
        maxTextBytes: 100,
        spawnFn: spawn.fn,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text.length).toBe(100);
  });

  it('removes its temp directory even when the conversion fails', async () => {
    let seen = '';
    const spawn = fakeSpawn({
      exitCode: 1,
      writes: async (outdir) => {
        seen = outdir;
      },
    });
    await convertToPlainText(Buffer.from('b'), 'application/x-mspublisher', 'a.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    if (seen !== '') {
      // A leaked temp dir per failed conversion would fill the disk over time.
      await expect(readdir(seen)).rejects.toThrow();
    }
  });

  it('writes the input with an extension so LibreOffice picks an import filter', async () => {
    let inputName = '';
    const spawn = fakeSpawn({
      writes: async (outdir) => {
        const files = await readdir(outdir);
        inputName = files.find((f) => f.startsWith('input.')) ?? '';
        await writeFile(`${outdir}/input.pdf`, '%PDF');
      },
    });
    await convertToPlainText(Buffer.from('b'), 'application/x-mspublisher', 'weird name.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    // Named from the MIME type, not the original filename, which may contain
    // characters that are awkward on a command line.
    expect(inputName).toBe('input.pub');
  });

  it('passes the original bytes through unmodified', async () => {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    let written: Buffer | undefined;
    const spawn = fakeSpawn({
      writes: async (outdir) => {
        written = await readFile(`${outdir}/input.pub`);
        await writeFile(`${outdir}/input.pdf`, '%PDF');
      },
    });
    await convertToPlainText(payload, 'application/x-mspublisher', 'a.pub', {
      ...OPTS,
      spawnFn: spawn.fn,
    });
    expect(written?.equals(payload)).toBe(true);
  });
});
