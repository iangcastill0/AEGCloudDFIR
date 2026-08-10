import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { merkleRoot, sortedMerkleRoot } from './merkle.js';

function h(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function pair(aHex: string, bHex: string): string {
  return h(Buffer.concat([Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex')]));
}

const A = h('leaf-a');
const B = h('leaf-b');
const C = h('leaf-c');
const D = h('leaf-d');

describe('merkleRoot', () => {
  it('empty list is the SHA-256 of the empty string', () => {
    expect(merkleRoot([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('single leaf is itself', () => {
    expect(merkleRoot([A])).toBe(A);
  });

  it('two leaves hash as a pair of raw digests', () => {
    expect(merkleRoot([A, B])).toBe(pair(A, B));
  });

  it('three leaves promote the odd node unchanged (no Bitcoin-style duplication)', () => {
    // level 1: [H(A||B), C]  ->  root: H(H(A||B) || C)
    expect(merkleRoot([A, B, C])).toBe(pair(pair(A, B), C));
    // Explicitly assert duplication semantics are NOT used:
    expect(merkleRoot([A, B, C])).not.toBe(pair(pair(A, B), pair(C, C)));
  });

  it('four leaves form a balanced tree', () => {
    expect(merkleRoot([A, B, C, D])).toBe(pair(pair(A, B), pair(C, D)));
  });

  it('is order-sensitive (caller controls ordering)', () => {
    expect(merkleRoot([A, B])).not.toBe(merkleRoot([B, A]));
  });

  it('rejects non-hex, uppercase, and wrong-length inputs', () => {
    expect(() => merkleRoot(['zz'])).toThrow(TypeError);
    expect(() => merkleRoot([A.toUpperCase()])).toThrow(TypeError);
    expect(() => merkleRoot([A.slice(0, 63)])).toThrow(TypeError);
  });
});

describe('sortedMerkleRoot', () => {
  it('is independent of input order', () => {
    const forward = sortedMerkleRoot([A, B, C, D]);
    expect(sortedMerkleRoot([D, C, B, A])).toBe(forward);
    expect(sortedMerkleRoot([C, A, D, B])).toBe(forward);
  });

  it('matches merkleRoot over pre-sorted leaves', () => {
    const sorted = [A, B, C].sort();
    expect(sortedMerkleRoot([C, A, B])).toBe(merkleRoot(sorted));
  });

  it('does not mutate its input', () => {
    const input = [B, A];
    sortedMerkleRoot(input);
    expect(input).toEqual([B, A]);
  });
});
