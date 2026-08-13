import { Readable, Transform, type TransformCallback } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/**
 * Database backup to object storage.
 *
 * The dump arrives on a stream rather than being produced here, because
 * pg_dump refuses to run against a server newer than itself. Taking it from the
 * postgres container's own pg_dump makes a version mismatch impossible, and
 * keeps the client out of the worker image entirely.
 *
 * Wasabi holds the evidence bytes under WORM retention, but the custody chain,
 * audit hash-chain, tags, cases and review work live only in PostgreSQL. Losing
 * it would leave perfectly verifiable bytes with no record of what they are or
 * who touched them, so this is the piece that makes the deployment recoverable.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** pg_dump custom-format files begin with this magic. */
const PGDMP_MAGIC = Buffer.from('PGDMP');

/** Hashes bytes as they stream past, without buffering the payload. */
class HashingPassThrough extends Transform {
  private readonly hash = createHash('sha256');
  private checkedMagic = false;
  private head = Buffer.alloc(0);
  bytes = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    // Fail at byte 5 rather than spending a whole upload on something that is
    // not a dump at all (an error message on stdout, an empty stream, gzip).
    if (!this.checkedMagic) {
      this.head = Buffer.concat([this.head, chunk]);
      if (this.head.length >= PGDMP_MAGIC.length) {
        this.checkedMagic = true;
        if (!this.head.subarray(0, PGDMP_MAGIC.length).equals(PGDMP_MAGIC)) {
          cb(
            new BackupError(
              'stream does not start with the pg_dump custom-format magic "PGDMP" — refusing to store it as a backup',
            ),
          );
          return;
        }
      }
    }
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}

export interface BackupManifest {
  /** Schema version of this manifest, so a future reader can adapt. */
  manifestVersion: 1;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  startedAt: string;
  finishedAt: string;
  /** pg_dump format; 'custom' restores with pg_restore. */
  dumpFormat: 'custom';
  pgVersion: string;
  /** Latest applied Prisma migration, so a restore can be matched to code. */
  migration: string;
  /**
   * Whether the uploaded object was re-read and re-hashed. An unverified backup
   * is an assumption, so this is recorded rather than implied.
   */
  verified: boolean;
}

export interface RunBackupOptions {
  s3: S3Client;
  bucket: string;
  /** The pg_dump output stream. */
  source: Readable;
  /** Injected for deterministic keys in tests. */
  now: () => Date;
  /** Queried for provenance; failures degrade to 'unknown' rather than aborting. */
  describeDatabase?: () => Promise<{ pgVersion: string; migration: string }>;
  /** Re-read and re-hash after upload. Default true. */
  verify?: boolean;
  /** Overridable for tests; production uses the real key layout. */
  keyPrefix?: string;
}

export interface BackupResult {
  objectKey: string;
  manifestKey: string;
  sha256: string;
  sizeBytes: number;
  verified: boolean;
  manifest: BackupManifest;
}

/** `postgres/2026-08-13/cdfir-2026-08-13T23-33-12-000Z.dump` */
export function backupObjectKey(at: Date, prefix = 'postgres'): string {
  const iso = at.toISOString();
  const day = iso.slice(0, 10);
  // ':' and '.' are legal in S3 keys but awkward in shells and URLs.
  const stamp = iso.replace(/[:.]/g, '-');
  return `${prefix}/${day}/cdfir-${stamp}.dump`;
}

export async function runBackup(options: RunBackupOptions): Promise<BackupResult> {
  const { s3, bucket, source, now } = options;
  if (bucket.length === 0) throw new BackupError('backup bucket is not configured');

  const startedAt = now();
  const objectKey = backupObjectKey(startedAt, options.keyPrefix ?? 'postgres');
  const manifestKey = `${objectKey}.manifest.json`;

  const hasher = new HashingPassThrough();
  // Errors on the source (pg_dump dying mid-stream) must abort the upload
  // rather than silently truncating it into a backup that looks complete.
  source.on('error', (err) => hasher.destroy(err));

  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: objectKey, Body: source.pipe(hasher) },
  });
  await upload.done();

  const sha256 = hasher.digestHex();
  const sizeBytes = hasher.bytes;
  if (sizeBytes === 0) {
    // A zero-byte dump means pg_dump produced nothing. Recording it as a backup
    // would be worse than failing, because it looks like a successful run.
    throw new BackupError('pg_dump produced no output; refusing to record an empty backup');
  }

  // Size check first: it is cheap and catches a truncated upload immediately.
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (head.ContentLength !== sizeBytes) {
    throw new BackupError(
      `uploaded object is ${String(head.ContentLength)} bytes but ${String(sizeBytes)} were sent`,
    );
  }

  let verified = false;
  if (options.verify !== false) {
    // Re-read and re-hash. This is what separates a backup from a hope: it
    // proves the bytes that landed are the bytes that left.
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    const body = got.Body;
    if (body === undefined) throw new BackupError('verification read returned no body');
    const check = createHash('sha256');
    let readBytes = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      check.update(chunk);
      readBytes += chunk.length;
    }
    const actual = check.digest('hex');
    if (actual !== sha256 || readBytes !== sizeBytes) {
      throw new BackupError(
        `verification failed: wrote sha256=${sha256} (${String(sizeBytes)} bytes), read back sha256=${actual} (${String(readBytes)} bytes)`,
      );
    }
    verified = true;
  }

  let pgVersion = 'unknown';
  let migration = 'unknown';
  if (options.describeDatabase) {
    try {
      const described = await options.describeDatabase();
      pgVersion = described.pgVersion;
      migration = described.migration;
    } catch {
      // Provenance is useful, not load-bearing. A backup with unknown metadata
      // still restores; refusing to record one because a metadata query failed
      // would trade a real backup for a cosmetic detail.
    }
  }

  const manifest: BackupManifest = {
    manifestVersion: 1,
    objectKey,
    sha256,
    sizeBytes,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    dumpFormat: 'custom',
    pgVersion,
    migration,
    verified,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    }),
  );

  return { objectKey, manifestKey, sha256, sizeBytes, verified, manifest };
}
