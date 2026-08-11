import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { Sha256Stream, hashBuffer, hashStreamToNull } from './hash.js';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function collectSink(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
}

describe('Sha256Stream', () => {
  it('hashes the known vector sha256("abc")', async () => {
    const hasher = new Sha256Stream();
    const out: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from('abc')]), hasher, collectSink(out));
    expect(hasher.digestHex()).toBe(ABC_SHA256);
    expect(hasher.bytesSeen).toBe(3);
    expect(Buffer.concat(out).toString()).toBe('abc');
  });

  it('produces the same digest for one chunk and many chunks', async () => {
    const single = new Sha256Stream();
    await pipeline(
      Readable.from([Buffer.from('hello world, this is a streaming hash test')]),
      single,
      collectSink([]),
    );

    const multi = new Sha256Stream();
    const pieces = ['hello ', 'world, ', 'this is ', 'a streaming', ' hash', ' test'].map((s) =>
      Buffer.from(s),
    );
    await pipeline(Readable.from(pieces), multi, collectSink([]));

    expect(multi.digestHex()).toBe(single.digestHex());
    expect(multi.bytesSeen).toBe(single.bytesSeen);
  });

  it('handles an empty stream', async () => {
    const hasher = new Sha256Stream();
    await pipeline(Readable.from([]), hasher, collectSink([]));
    expect(hasher.digestHex()).toBe(EMPTY_SHA256);
    expect(hasher.bytesSeen).toBe(0);
  });

  it('throws when digestHex is called before the stream finishes', () => {
    const hasher = new Sha256Stream();
    expect(() => hasher.digestHex()).toThrow(/before the stream finished/);
  });

  it('passes bytes through unchanged for large multi-chunk payloads', async () => {
    const chunkA = Buffer.alloc(64 * 1024, 7);
    const chunkB = Buffer.alloc(32 * 1024, 9);
    const expected = createHash('sha256')
      .update(Buffer.concat([chunkA, chunkB]))
      .digest('hex');
    const hasher = new Sha256Stream();
    const out: Buffer[] = [];
    await pipeline(Readable.from([chunkA, chunkB]), hasher, collectSink(out));
    expect(hasher.digestHex()).toBe(expected);
    expect(hasher.bytesSeen).toBe(chunkA.length + chunkB.length);
    expect(Buffer.concat(out).equals(Buffer.concat([chunkA, chunkB]))).toBe(true);
  });
});

describe('hashBuffer', () => {
  it('hashes a buffer to lowercase hex', () => {
    expect(hashBuffer(Buffer.from('abc'))).toBe(ABC_SHA256);
    expect(hashBuffer(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });
});

describe('hashStreamToNull', () => {
  it('returns digest and size without retaining the payload', async () => {
    const { sha256, size } = await hashStreamToNull(Readable.from([Buffer.from('abc')]));
    expect(sha256).toBe(ABC_SHA256);
    expect(size).toBe(3);
  });

  it('handles an empty stream', async () => {
    const { sha256, size } = await hashStreamToNull(Readable.from([]));
    expect(sha256).toBe(EMPTY_SHA256);
    expect(size).toBe(0);
  });
});
