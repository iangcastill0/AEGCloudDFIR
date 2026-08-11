import { createHash } from 'node:crypto';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function sha256Pair(a: Buffer, b: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([a, b]))
    .digest();
}

/**
 * Deterministic Merkle root over SHA-256 leaf hashes.
 *
 * - Each level hashes SHA-256 over the concatenation of pairs of raw 32-byte
 *   digests.
 * - An odd node at any level is PROMOTED to the next level unchanged
 *   (Bitcoin-style duplication of the last node is deliberately NOT used).
 * - Empty input -> SHA-256 of the empty string
 *   (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855).
 * - Single leaf -> the leaf itself.
 * - Leaves are consumed in the given order; the caller is responsible for
 *   ordering (see sortedMerkleRoot).
 */
export function merkleRoot(hashesHex: string[]): string {
  if (!Array.isArray(hashesHex)) {
    throw new TypeError('merkleRoot: expected an array of hex strings');
  }
  for (const h of hashesHex) {
    if (typeof h !== 'string' || !SHA256_HEX_RE.test(h)) {
      throw new TypeError(
        `merkleRoot: every hash must be 64 lowercase hex characters, got: ${JSON.stringify(h)}`,
      );
    }
  }
  if (hashesHex.length === 0) {
    return createHash('sha256').update('').digest('hex');
  }
  let level: Buffer[] = hashesHex.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (a === undefined) break; // unreachable; satisfies noUncheckedIndexedAccess
      next.push(b === undefined ? a : sha256Pair(a, b));
    }
    level = next;
  }
  const root = level[0];
  if (root === undefined) {
    throw new Error('merkleRoot: internal error, empty level');
  }
  return root.toString('hex');
}

/**
 * Merkle root over the leaves sorted lexicographically first, making the
 * result independent of input order. Does not mutate the input array.
 */
export function sortedMerkleRoot(hashesHex: string[]): string {
  return merkleRoot([...hashesHex].sort());
}
