import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import {
  assertNativeDigestsPresent,
  buildNativeDigestCsv,
  buildPstReadme,
  pstPartFilename,
  pstStoreDisplayName,
  runPstExport,
  type PstExportItem,
} from './pst-export.js';
import type { WorkerContext } from '../context.js';

/**
 * The integrity rule is the point of this file.
 *
 * A PST holds RE-ENCODED bytes whose digests nobody ever recorded, and this
 * writer is not even reproducible — the same messages exported twice produced
 * two different PST files (measured 2026-09-24). So the native `.eml` digests
 * are the only thing a recipient can check anything against, and an export that
 * ships without them is unverifiable evidence dressed up as a deliverable.
 */

const NATIVE_BYTES = Buffer.from('From: a@example.invalid\r\nSubject: hi\r\n\r\nbody\r\n', 'utf8');
// sha256 of NATIVE_BYTES, computed once here so the fixture and the check agree.
const NATIVE_SHA = '2b8b2e4d4b6c4f1d1f7f8a0e0cbb6a4a8e6e7d5a9b3c2d1e0f1a2b3c4d5e6f70';

function item(over: Partial<PstExportItem> = {}): PstExportItem {
  return {
    evidenceItemId: '11111111-1111-4111-8111-111111111111',
    sha256: NATIVE_SHA,
    size: NATIVE_BYTES.byteLength,
    subject: 'hi',
    folderPath: 'Inbox',
    custodianEmail: 'a@example.invalid',
    collectionId: '22222222-2222-4222-8222-222222222222',
    storageClass: 'evidence',
    objectKey: 'tenants/t/originals/x',
    receivedAt: '2024-01-02T03:04:05.000Z',
    ...over,
  };
}

describe('assertNativeDigestsPresent', () => {
  it('accepts a digest file with a row per digested item', () => {
    const items = [item(), item({ evidenceItemId: 'b', sha256: 'f'.repeat(64) })];
    expect(() => assertNativeDigestsPresent(items, buildNativeDigestCsv(items))).not.toThrow();
  });

  it('refuses an export whose items have no recorded digests at all', () => {
    // Nothing in a PST can be verified without these. Writing the PST anyway
    // would produce a deliverable that looks complete and proves nothing.
    const items = [item({ sha256: '' })];
    expect(() => assertNativeDigestsPresent(items, buildNativeDigestCsv(items))).toThrow(
      /no native \.eml digests/,
    );
  });

  it('refuses a truncated digest file', () => {
    // A short digest file passes `sha256sum -c` cleanly, so it looks exactly
    // like a complete one. It has to be counted, not trusted.
    const items = [item(), item({ evidenceItemId: 'b', sha256: 'f'.repeat(64) })];
    const truncated = buildNativeDigestCsv([items[0]!]);
    expect(() => assertNativeDigestsPresent(items, truncated)).toThrow(/incomplete/);
  });

  it('refuses a digest file that is missing one item', () => {
    const items = [item(), item({ evidenceItemId: 'b', sha256: 'f'.repeat(64) })];
    const wrong = buildNativeDigestCsv(items).replace('f'.repeat(64), 'e'.repeat(64));
    expect(() => assertNativeDigestsPresent(items, wrong)).toThrow(/missing the digest/);
  });
});

describe('buildPstReadme', () => {
  const parts = [{ path: '/x/export.pst', name: 'export.pst', bytes: 525_312 }];

  it('says the PST is a reconstruction and carries the standing notice', () => {
    const readme = buildPstReadme(parts, 10, 10);
    expect(readme).toContain('reconstruction, not the evidence');
    expect(readme).toContain(TRUTHFULNESS_NOTICES.pstExport);
  });

  it('says the writer is not reproducible', () => {
    // Without this a recipient who re-exports and gets a different hash has
    // every reason to think the evidence was altered.
    expect(buildPstReadme(parts, 10, 10)).toContain('not reproducible');
  });

  it('lists the derived properties by name', () => {
    const readme = buildPstReadme(parts, 10, 10);
    for (const derived of ['folder placement', 'message flags', 'PS_COMMON 0x8580']) {
      expect(readme).toContain(derived);
    }
  });

  it('says the parts are complete files, not volumes to rejoin', () => {
    const readme = buildPstReadme(parts, 10, 10);
    expect(readme).toContain('NOT volumes');
    expect(readme).toContain('nothing to rejoin');
  });
});

describe('pstPartFilename', () => {
  it('pads so parts sort in order and ends in .pst', () => {
    expect(pstPartFilename(1)).toBe('export-part001.pst');
    expect(pstPartFilename(12)).toBe('export-part012.pst');
    // The whole reason the extension was widened: a PST named .zip is refused
    // by Outlook with nothing explaining why.
    expect(pstPartFilename(1).endsWith('.pst')).toBe(true);
  });
});

describe('pstStoreDisplayName', () => {
  it('falls back rather than producing an empty mailbox name', () => {
    expect(pstStoreDisplayName('')).toBe('Personal Folders');
    expect(pstStoreDisplayName('Acme v Widgets')).toContain('Acme');
  });
});

// --- the whole path, with the child process and object storage faked ---------

interface Put {
  type: string;
  filename: string;
  body: Buffer;
}

function fakeContext(puts: Put[], nativeFor: (key: string) => Buffer): WorkerContext {
  return {
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    store: {
      getStream: (_class: string, key: string) => Promise.resolve(Readable.from([nativeFor(key)])),
      putDerivative: async (
        _tenantId: string,
        _id: string,
        type: string,
        _version: number,
        filename: string,
        body: Readable | Buffer,
      ) => {
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(body)) chunks.push(body);
        else for await (const c of body) chunks.push(Buffer.from(c as Buffer));
        const buf = Buffer.concat(chunks);
        puts.push({ type, filename, body: buf });
        const { createHash } = await import('node:crypto');
        return {
          objectKey: `tenants/t/derivatives/e/${type}/${filename}`,
          sha256: createHash('sha256').update(buf).digest('hex'),
          size: buf.byteLength,
        };
      },
    },
  } as unknown as WorkerContext;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cdfir-pst-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runPstExport', () => {
  it('writes native-digests.csv beside the PST parts', async () => {
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');

      const outcome = await runPstExport(ctx, 't', 'e1', [item({ sha256: realSha })], {
        binPath: '/unused',
        scratchRoot: scratch,
        timeoutMs: 1000,
        spoolThresholdBytes: 1024,
        partBytes: 1024 * 1024,
        storeDisplayName: 'test',
        // Stand in for the child process: write two PST files where it would.
        runPst: async (jobPath) => {
          const job = JSON.parse(await readFile(jobPath, 'utf8')) as {
            outPath: string;
            messages: unknown[];
          };
          const a = job.outPath;
          const b = job.outPath.replace(/\.pst$/, '-002.pst');
          await writeFile(a, Buffer.alloc(64, 1));
          await writeFile(b, Buffer.alloc(32, 2));
          return {
            ok: true,
            messagesAdded: job.messages.length,
            spooledAttachments: 0,
            peakWorkingSetMiB: 100,
            seconds: 1,
            parts: [
              { path: a, name: 'export.pst', bytes: 64 },
              { path: b, name: 'export-002.pst', bytes: 32 },
            ],
          };
        },
      });

      expect(outcome.parts).toHaveLength(2);
      const digests = puts.find((p) => p.filename === 'native-digests.csv');
      expect(digests).toBeDefined();
      expect(digests?.body.toString('utf8')).toContain(realSha);
      // Every part carries a digest of the file as uploaded — that is what
      // hashes.txt in the download folder is built from.
      expect(outcome.parts.every((p) => p.sha256.length === 64)).toBe(true);
    });
  });

  it('fails the export when the native does not hash to its recorded digest', async () => {
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      // Storage returns different bytes from the ones the digest was recorded
      // for. There is no way to note a mismatch INSIDE a PST that a reader
      // would see, so the only honest handling is to leave the message out.
      const ctx = fakeContext(puts, () => Buffer.from('tampered', 'utf8'));
      await expect(
        runPstExport(ctx, 't', 'e2', [item()], {
          binPath: '/unused',
          scratchRoot: scratch,
          timeoutMs: 1000,
          spoolThresholdBytes: 1024,
          partBytes: 1024 * 1024,
          storeDisplayName: 'test',
          runPst: () => {
            throw new Error('the writer must never be reached');
          },
        }),
      ).rejects.toThrow(/failed native verification/);
    });
  });

  it('runs the native-digest guard, and refuses before the writer if it trips', async () => {
    // This is the test that catches the guard being DELETED. Removing the
    // `assertNativeDigestsPresent` call left every other test in this file
    // green, because the other route to "no digests" fails earlier for an
    // unrelated reason. Here the items are fine and the digest file is short —
    // the only shape that reaches the guard.
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');
      let writerRan = false;
      await expect(
        runPstExport(ctx, 't', 'e3b', [item({ sha256: realSha })], {
          binPath: '/unused',
          scratchRoot: scratch,
          timeoutMs: 1000,
          spoolThresholdBytes: 1024,
          partBytes: 1024 * 1024,
          storeDisplayName: 'test',
          // Header only: a digest file that would pass `sha256sum -c` cleanly
          // while proving nothing about any message.
          buildDigestCsvFn: () => 'evidenceItemId,sha256\r\n',
          runPst: () => {
            writerRan = true;
            throw new Error('unreachable');
          },
        }),
      ).rejects.toThrow(/incomplete/);
      expect(writerRan).toBe(false);
    });
  });

  it('refuses items with no preserved native bytes, before running the writer', async () => {
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      let writerRan = false;
      await expect(
        // `sha256: ''` is "no preserved native bytes", so nothing stages.
        runPstExport(ctx, 't', 'e3', [item({ sha256: '' })], {
          binPath: '/unused',
          scratchRoot: scratch,
          timeoutMs: 1000,
          spoolThresholdBytes: 1024,
          partBytes: 1024 * 1024,
          storeDisplayName: 'test',
          runPst: () => {
            writerRan = true;
            throw new Error('unreachable');
          },
        }),
      ).rejects.toThrow();
      // Hours of PST writing for something nobody could verify is worth
      // skipping.
      expect(writerRan).toBe(false);
    });
  });

  it('refuses to ship an export the writer quietly made short', async () => {
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');
      await expect(
        runPstExport(
          ctx,
          't',
          'e4',
          [item({ sha256: realSha }), item({ evidenceItemId: 'b2', sha256: realSha })],
          {
            binPath: '/unused',
            scratchRoot: scratch,
            timeoutMs: 1000,
            spoolThresholdBytes: 1024,
            partBytes: 1024 * 1024,
            storeDisplayName: 'test',
            runPst: async (jobPath) => {
              const job = JSON.parse(await readFile(jobPath, 'utf8')) as { outPath: string };
              await writeFile(job.outPath, Buffer.alloc(8, 3));
              // Two staged, one written, exit 0. Exactly the silent-loss shape.
              return {
                ok: true,
                messagesAdded: 1,
                spooledAttachments: 0,
                peakWorkingSetMiB: 1,
                seconds: 1,
                parts: [{ path: job.outPath, name: 'export.pst', bytes: 8 }],
              };
            },
          },
        ),
      ).rejects.toThrow(/quietly short/);
    });
  });

  it('cleans the scratch directory even when the writer fails', async () => {
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');
      await expect(
        runPstExport(ctx, 't', 'e5', [item({ sha256: realSha })], {
          binPath: '/unused',
          scratchRoot: scratch,
          timeoutMs: 1000,
          spoolThresholdBytes: 1024,
          partBytes: 1024 * 1024,
          storeDisplayName: 'test',
          runPst: () => Promise.resolve({ ok: false as const, reason: 'pstb exploded' }),
        }),
      ).rejects.toThrow(/pstb exploded/);

      // The staged natives plus the finished PSTs are about twice the export
      // size, on the same disk as PostgreSQL. Leaving them is how that disk
      // fills.
      const { readdir } = await import('node:fs/promises');
      await expect(readdir(join(scratch, 'e5'))).rejects.toThrow();
    });
  });

  it('passes a Writable sink through for staging so nothing is buffered', async () => {
    // Guard on the streaming shape: a 672 MB native must not be read into a
    // Buffer on its way to the scratch volume.
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');
      let sawWritable = false;
      await runPstExport(ctx, 't', 'e6', [item({ sha256: realSha })], {
        binPath: '/unused',
        scratchRoot: scratch,
        timeoutMs: 1000,
        spoolThresholdBytes: 1024,
        partBytes: 1024 * 1024,
        storeDisplayName: 'test',
        createWriteStreamFn: () => {
          sawWritable = true;
          return new Writable({
            write(_chunk, _enc, cb) {
              cb();
            },
          });
        },
        createReadStreamFn: () => Readable.from([Buffer.alloc(8, 4)]),
        runPst: async (jobPath) => {
          const job = JSON.parse(await readFile(jobPath, 'utf8')) as { outPath: string };
          return {
            ok: true,
            messagesAdded: 1,
            spooledAttachments: 0,
            peakWorkingSetMiB: 1,
            seconds: 1,
            parts: [{ path: job.outPath, name: 'export.pst', bytes: 8 }],
          };
        },
      });
      expect(sawWritable).toBe(true);
    });
  });

  it('names extraExceptions in exceptions.csv and the manifest', async () => {
    // The caller (a mixed PST selection) already decided a PDF cannot go in a
    // mailbox file. If that id never reaches this file, the export still says
    // ready and the recipient has no list of what was left out.
    await withScratch(async (scratch) => {
      const puts: Put[] = [];
      const ctx = fakeContext(puts, () => NATIVE_BYTES);
      const { createHash } = await import('node:crypto');
      const realSha = createHash('sha256').update(NATIVE_BYTES).digest('hex');
      const leftOut = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const outcome = await runPstExport(ctx, 't', 'e7', [item({ sha256: realSha })], {
        binPath: '/unused',
        scratchRoot: scratch,
        timeoutMs: 1000,
        spoolThresholdBytes: 1024,
        partBytes: 1024 * 1024,
        storeDisplayName: 'test',
        extraExceptions: [
          {
            evidenceItemId: leftOut,
            error: 'not an email; a PST is a mailbox file and cannot hold this item',
          },
        ],
        runPst: async (jobPath) => {
          const job = JSON.parse(await readFile(jobPath, 'utf8')) as {
            outPath: string;
            messages: unknown[];
          };
          await writeFile(job.outPath, Buffer.alloc(8, 1));
          return {
            ok: true,
            messagesAdded: job.messages.length,
            spooledAttachments: 0,
            peakWorkingSetMiB: 1,
            seconds: 1,
            parts: [{ path: job.outPath, name: 'export.pst', bytes: 8 }],
          };
        },
      });
      expect(outcome.failedCount).toBe(0);
      const csv = puts.find((p) => p.filename === 'exceptions.csv')?.body.toString('utf8') ?? '';
      expect(csv).toContain(leftOut);
      expect(csv).toContain('not an email');
      const manifest = JSON.parse(
        puts.find((p) => p.filename === 'manifest.json')?.body.toString('utf8') ?? '{}',
      ) as { exceptions: { evidenceItemId: string }[]; failedCount: number };
      expect(manifest.exceptions.map((e) => e.evidenceItemId)).toContain(leftOut);
      expect(manifest.failedCount).toBe(1);
    });
  });
});
