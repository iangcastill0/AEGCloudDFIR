import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveBombError, ArchiveDepthExceededError } from './errors.js';
import { ExpansionGuard, gunzipCapped } from './limits.js';

function guard(
  overrides: Partial<ConstructorParameters<typeof ExpansionGuard>[0]> = {},
): ExpansionGuard {
  return new ExpansionGuard({
    maxDepth: 3,
    maxRatio: 100,
    maxTotalBytes: 1024 * 1024,
    inputSize: 1024,
    ...overrides,
  });
}

describe('ExpansionGuard: expansion ratio', () => {
  it('throws ArchiveBombError when output/input exceeds maxRatio', () => {
    const g = guard({ maxRatio: 10, inputSize: 100, maxTotalBytes: 10_000_000 });
    g.addOutputBytes(1000); // exactly 10x — allowed
    expect(() => g.addOutputBytes(1)).toThrow(ArchiveBombError);
  });

  it('accumulates across many small entries', () => {
    const g = guard({ maxRatio: 10, inputSize: 100, maxTotalBytes: 10_000_000 });
    for (let i = 0; i < 10; i += 1) g.addOutputBytes(100);
    expect(() => g.addOutputBytes(100)).toThrow(ArchiveBombError);
  });
});

describe('ExpansionGuard: absolute total', () => {
  it('throws ArchiveBombError past maxTotalBytes even at a low ratio', () => {
    const g = guard({ maxRatio: 1_000_000, inputSize: 1024, maxTotalBytes: 4096 });
    g.addOutputBytes(4096);
    expect(() => g.addOutputBytes(1)).toThrow(ArchiveBombError);
  });

  it('rejects negative or non-finite byte counts', () => {
    const g = guard();
    expect(() => g.addOutputBytes(-1)).toThrow(TypeError);
    expect(() => g.addOutputBytes(Number.NaN)).toThrow(TypeError);
  });
});

describe('ExpansionGuard: depth', () => {
  it('throws ArchiveDepthExceededError beyond maxDepth', () => {
    const g = guard({ maxDepth: 2 });
    const outer = g.enterArchive();
    const inner = g.enterArchive();
    expect(() => g.enterArchive()).toThrow(ArchiveDepthExceededError);
    inner.exit();
    outer.exit();
    expect(g.currentDepth).toBe(0);
  });

  it('allows re-entry after exiting and makes exit idempotent', () => {
    const g = guard({ maxDepth: 1 });
    const scope = g.enterArchive();
    scope.exit();
    scope.exit(); // no double decrement
    expect(g.currentDepth).toBe(0);
    const again = g.enterArchive();
    again.exit();
  });
});

describe('gunzipCapped', () => {
  it('decompresses within budget and charges the guard', () => {
    const payload = Buffer.from('hello world, small and honest payload');
    const g = guard({ maxRatio: 1000, inputSize: 64, maxTotalBytes: 10_000 });
    const out = gunzipCapped(gzipSync(payload), g);
    expect(out.equals(payload)).toBe(true);
    expect(g.totalOutputBytes).toBe(payload.length);
  });

  it('throws ArchiveBombError on a gzip bomb without materializing it', () => {
    // 10 MB of zeros compresses to ~10 KB; the cap is far smaller.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    const g = guard({ maxRatio: 1_000_000, inputSize: bomb.length, maxTotalBytes: 64 * 1024 });
    expect(() => gunzipCapped(bomb, g)).toThrow(ArchiveBombError);
  });

  it('throws ArchiveBombError when the ratio budget is the binding limit', () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024));
    const g = guard({ maxRatio: 2, inputSize: bomb.length, maxTotalBytes: 1024 * 1024 * 1024 });
    expect(() => gunzipCapped(bomb, g)).toThrow(ArchiveBombError);
  });

  it('propagates genuine corruption errors unchanged', () => {
    const g = guard();
    expect(() => gunzipCapped(Buffer.from('not gzip data'), g)).toThrow(
      /incorrect header|unknown compression/i,
    );
  });
});
