/**
 * The checking half of the missing-object sweep, kept apart from the CLI so it
 * can be tested without a database, a Redis or a `process.exit`.
 *
 * See sweep-missing-objects.ts for why the sweep exists at all.
 */
import { isObjectNotFoundError } from '@aeg-clouddfir/evidence';
import type { ObjectStorePort } from './context.js';

/**
 * What one HEAD told us.
 *
 * `error` is deliberately NOT folded into `missing`. An AccessDenied and an
 * absent key look the same to code that only asks "did it fail", and calling a
 * permissions problem a data-loss event is the same class of mistake this
 * whole change exists to undo. Unknown stays unknown.
 */
export type SweepVerdict = 'present' | 'missing' | 'size_mismatch' | 'error';

export interface SweepBlob {
  id: string;
  sha256: string;
  size: bigint;
  objectKey: string;
  storageClass: 'original' | 'quarantine';
}

export interface SweepResult {
  verdict: SweepVerdict;
  /** Length storage reported, when it answered at all. */
  actualSize?: number;
  error?: string;
}

/**
 * HEAD one blob's object and judge it.
 *
 * A HEAD proves the key exists and how long it is. It does NOT re-hash the
 * bytes, so this can say "present at the recorded length" and never "intact".
 */
export async function checkBlob(
  store: Pick<ObjectStorePort, 'headObject'>,
  blob: SweepBlob,
): Promise<SweepResult> {
  const bucket = blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence';
  try {
    const head = await store.headObject(bucket, blob.objectKey);
    if (head === null) return { verdict: 'missing' };
    if (head.size !== Number(blob.size)) {
      return { verdict: 'size_mismatch', actualSize: head.size };
    }
    return { verdict: 'present' };
  } catch (err) {
    // headObject already turns a genuine absence into null. If a not-found
    // still arrives as a throw the store changed underneath us, so honour it
    // rather than silently reclassifying it as an error.
    if (isObjectNotFoundError(err)) return { verdict: 'missing' };
    return {
      verdict: 'error',
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/**
 * Run `task` over `items` with at most `limit` of them in flight.
 *
 * A plain Promise.all over a page of 2,000 rows would put 2,000 requests on the
 * wire at once. Wasabi is also serving the live worker pool while this runs;
 * a background check must not become the thing that slows collections down.
 */
export async function pooled<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (limit < 1) throw new RangeError('pooled: limit must be at least 1');
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await task(items[index] as T);
    }
  });
  await Promise.all(workers);
}
