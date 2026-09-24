import { describe, expect, it, vi } from 'vitest';
import { checkBlob, pooled, type SweepBlob } from './object-sweep.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function blob(overrides: Partial<SweepBlob> = {}): SweepBlob {
  return {
    id: 'blob-1',
    sha256: 'a'.repeat(64),
    size: 1024n,
    objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
    storageClass: 'original',
    ...overrides,
  };
}

function s3Error(name: string, httpStatusCode: number): Error {
  const err = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  err.name = name;
  err.$metadata = { httpStatusCode };
  return err;
}

describe('checkBlob', () => {
  it('present when the object is there at the recorded length', async () => {
    const store = { headObject: vi.fn().mockResolvedValue({ size: 1024 }) };
    expect(await checkBlob(store, blob())).toEqual({ verdict: 'present' });
    expect(store.headObject).toHaveBeenCalledWith('evidence', blob().objectKey);
  });

  it('missing when the key is absent', async () => {
    const store = { headObject: vi.fn().mockResolvedValue(null) };
    expect(await checkBlob(store, blob())).toEqual({ verdict: 'missing' });
  });

  it('size_mismatch is its own verdict, not "present"', async () => {
    // An object that is there but the wrong length is a different problem from
    // one that is gone, and calling it present would hide it entirely.
    const store = { headObject: vi.fn().mockResolvedValue({ size: 12 }) };
    expect(await checkBlob(store, blob())).toEqual({ verdict: 'size_mismatch', actualSize: 12 });
  });

  it('AccessDenied is "error", never "missing"', async () => {
    // The sweep exists to count lost evidence. Counting a permissions problem
    // as lost evidence would be the same mistake it was built to undo.
    const store = { headObject: vi.fn().mockRejectedValue(s3Error('AccessDenied', 403)) };
    const result = await checkBlob(store, blob());
    expect(result.verdict).toBe('error');
    expect(result.error).toContain('AccessDenied');
  });

  it('heads the quarantine bucket for a quarantined blob', async () => {
    const store = { headObject: vi.fn().mockResolvedValue({ size: 1024 }) };
    await checkBlob(store, blob({ storageClass: 'quarantine' }));
    expect(store.headObject).toHaveBeenCalledWith('quarantine', expect.any(String));
  });
});

describe('pooled', () => {
  it('never runs more than the limit at once', async () => {
    // 480,989 objects. A Promise.all over a page would put the whole page on
    // the wire while the live worker pool is using the same store.
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    await pooled(items, 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('visits every item exactly once', async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];
    await pooled(items, 5, async (n) => {
      await Promise.resolve();
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    await pooled([], 8, task);
    expect(task).not.toHaveBeenCalled();
    await pooled([1, 2], 99, task);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
