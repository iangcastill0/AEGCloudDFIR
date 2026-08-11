import { describe, expect, it } from 'vitest';
import { backoffWithJitter, dedupKeys } from './queues.js';
import { sanitizeJobId } from './bullmq-enqueuer.js';

describe('backoffWithJitter', () => {
  it('grows exponentially up to the cap', () => {
    expect(backoffWithJitter(1, 2000, 300_000, () => 1)).toBe(2000);
    expect(backoffWithJitter(2, 2000, 300_000, () => 1)).toBe(4000);
    expect(backoffWithJitter(5, 2000, 300_000, () => 1)).toBe(32_000);
    expect(backoffWithJitter(20, 2000, 300_000, () => 1)).toBe(300_000);
  });

  it('applies full jitter (0 .. exp)', () => {
    expect(backoffWithJitter(3, 2000, 300_000, () => 0)).toBe(0);
    expect(backoffWithJitter(3, 2000, 300_000, () => 0.5)).toBe(4000);
  });
});

describe('dedup keys', () => {
  it('are deterministic and distinct per logical work unit', () => {
    expect(dedupKeys.collectionFetchItem('c1', 'u1', 'email', 'm-1')).toBe(
      dedupKeys.collectionFetchItem('c1', 'u1', 'email', 'm-1'),
    );
    expect(dedupKeys.collectionFetchItem('c1', 'u1', 'email', 'm-1')).not.toBe(
      dedupKeys.collectionFetchItem('c1', 'u2', 'email', 'm-1'),
    );
    expect(dedupKeys.processStage('parse', 'e1', 1)).not.toBe(
      dedupKeys.processStage('parse', 'e1', 2),
    );
  });
});

describe('sanitizeJobId', () => {
  it('rejects empty and oversized keys', () => {
    expect(() => sanitizeJobId('')).toThrow();
    expect(() => sanitizeJobId('x'.repeat(513))).toThrow();
    // Colons are remapped because BullMQ custom job ids may not contain ':'.
    expect(sanitizeJobId('ok:1')).toBe('ok__1');
    expect(sanitizeJobId('discover:abc')).toBe('discover__abc');
  });
});
