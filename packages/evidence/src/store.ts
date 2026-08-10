import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IntegrityError, KeyValidationError } from './errors.js';
import { Sha256Stream, hashBuffer, hashStreamToNull } from './hash.js';
import {
  assertKeyInTenant,
  derivativeKey,
  keyClass,
  manifestKey,
  originalKey,
  quarantineKey,
  stagingKey,
} from './objectKeys.js';

export type BucketClass = 'evidence' | 'quarantine';

/**
 * Injectable presigner, primarily for tests. Defaults to
 * @aws-sdk/s3-request-presigner getSignedUrl.
 */
export type PresignFn = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export interface EvidenceObjectStoreOptions {
  s3: S3Client;
  evidenceBucket: string;
  quarantineBucket: string;
  /** Hard upper bound for presigned URL TTLs, in seconds. */
  presignTtlSeconds: number;
  /** Test seam; production code should omit this. */
  presignFn?: PresignFn;
}

export interface StageResult {
  stagingKey: string;
  sha256: string;
  size: number;
}

export interface PromoteResult {
  objectKey: string;
  bucket: string;
}

export interface BucketProtection {
  versioningEnabled: boolean;
  objectLockEnabled: boolean;
  objectLockMode?: string;
  /** Honest, human-readable statement — never claims WORM unless Object Lock is actually on. */
  honest: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.name === 'ObjectLockConfigurationNotFoundError' ||
    e.name === 'NoSuchObjectLockConfiguration'
  ) {
    return true;
  }
  return e.$metadata?.httpStatusCode === 404;
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Content-addressed, tenant-scoped object store for evidence originals,
 * derivatives, manifests, productions, and exports.
 *
 * Originals are immutable: bytes are staged, verified, then promoted to a
 * content-addressed key; existing destination objects are never overwritten.
 */
export class EvidenceObjectStore {
  private readonly s3: S3Client;
  private readonly evidenceBucket: string;
  private readonly quarantineBucket: string;
  private readonly presignTtlSeconds: number;
  private readonly presignFn: PresignFn;

  constructor(options: EvidenceObjectStoreOptions) {
    if (!Number.isInteger(options.presignTtlSeconds) || options.presignTtlSeconds <= 0) {
      throw new TypeError('presignTtlSeconds must be a positive integer');
    }
    this.s3 = options.s3;
    this.evidenceBucket = options.evidenceBucket;
    this.quarantineBucket = options.quarantineBucket;
    this.presignTtlSeconds = options.presignTtlSeconds;
    this.presignFn =
      options.presignFn ??
      ((client, command, opts) => getSignedUrl(client, command, { expiresIn: opts.expiresIn }));
  }

  private bucketFor(bucketClass: BucketClass): string {
    return bucketClass === 'quarantine' ? this.quarantineBucket : this.evidenceBucket;
  }

  /**
   * Stream bytes into a staging key while computing SHA-256 and size.
   * Never buffers the payload; uses multipart upload for large streams.
   */
  async stageStream(tenantId: string, readable: Readable): Promise<StageResult> {
    const key = stagingKey(tenantId, randomUUID());
    const hasher = new Sha256Stream();
    const body = readable.pipe(hasher);
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.evidenceBucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      },
    });
    await upload.done();
    return { stagingKey: key, sha256: hasher.digestHex(), size: hasher.bytesSeen };
  }

  /**
   * Verify a staged object and promote it to its immutable content-addressed
   * key (or to the quarantine bucket for malware).
   *
   * Idempotent: if the destination already exists with the expected size the
   * copy is skipped (dedup hit / resumed promotion) and staging is cleaned up.
   * On integrity failure the staging object is retained for investigation.
   */
  async promoteToOriginal(
    tenantId: string,
    sourceStagingKey: string,
    expected: { sha256: string; size: number },
    opts?: { quarantine?: boolean },
  ): Promise<PromoteResult> {
    assertKeyInTenant(tenantId, sourceStagingKey);
    if (keyClass(sourceStagingKey) !== 'staging') {
      throw new KeyValidationError('promoteToOriginal requires a staging-class key');
    }
    if (!SHA256_HEX_RE.test(expected.sha256)) {
      throw new KeyValidationError('expected.sha256 must be 64 lowercase hex characters');
    }
    if (!Number.isInteger(expected.size) || expected.size < 0) {
      throw new KeyValidationError('expected.size must be a non-negative integer');
    }

    const quarantine = opts?.quarantine === true;
    const destBucket = quarantine ? this.quarantineBucket : this.evidenceBucket;
    const destKey = quarantine
      ? quarantineKey(tenantId, expected.sha256)
      : originalKey(tenantId, expected.sha256);

    // Never overwrite: check the destination first. Same size => dedup hit.
    const existing = await this.headOrNull(destBucket, destKey);
    if (existing !== null) {
      if (existing.size !== expected.size) {
        throw new IntegrityError(
          'destination object already exists with a different size; refusing to touch it',
          { key: destKey, existingSize: existing.size, expectedSize: expected.size },
        );
      }
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.evidenceBucket, Key: sourceStagingKey }),
      );
      return { objectKey: destKey, bucket: destBucket };
    }

    // Verify the staged bytes before promotion. Staging is kept on failure.
    const staged = await this.headOrNull(this.evidenceBucket, sourceStagingKey);
    if (staged === null) {
      throw new IntegrityError('staging object not found', { key: sourceStagingKey });
    }
    if (staged.size !== expected.size) {
      throw new IntegrityError('staging object size does not match expected size', {
        key: sourceStagingKey,
        actualSize: staged.size,
        expectedSize: expected.size,
      });
    }

    await this.s3.send(
      new CopyObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        CopySource: encodeCopySource(this.evidenceBucket, sourceStagingKey),
        MetadataDirective: 'COPY',
      }),
    );

    // Verify the copy landed with the right size before deleting staging.
    const copied = await this.headOrNull(destBucket, destKey);
    if (copied === null || copied.size !== expected.size) {
      throw new IntegrityError('copied object failed post-copy size verification', {
        key: destKey,
        actualSize: copied?.size,
        expectedSize: expected.size,
      });
    }

    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.evidenceBucket, Key: sourceStagingKey }),
    );
    return { objectKey: destKey, bucket: destBucket };
  }

  /** Upload a derivative object, hashing while streaming. */
  async putDerivative(
    tenantId: string,
    evidenceId: string,
    type: string,
    version: number,
    filename: string,
    body: Readable | Buffer,
    contentType: string,
  ): Promise<{ objectKey: string; sha256: string; size: number }> {
    const key = derivativeKey(tenantId, evidenceId, type, version, filename);
    if (Buffer.isBuffer(body)) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.evidenceBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { objectKey: key, sha256: hashBuffer(body), size: body.byteLength };
    }
    const hasher = new Sha256Stream();
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.evidenceBucket,
        Key: key,
        Body: body.pipe(hasher),
        ContentType: contentType,
      },
    });
    await upload.done();
    return { objectKey: key, sha256: hasher.digestHex(), size: hasher.bytesSeen };
  }

  /** Store a collection manifest (already-serialized canonical JSON). */
  async putManifest(
    tenantId: string,
    collectionId: string,
    manifestJsonString: string,
  ): Promise<{ objectKey: string; sha256: string }> {
    const key = manifestKey(tenantId, collectionId);
    const bytes = Buffer.from(manifestJsonString, 'utf8');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.evidenceBucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/json',
      }),
    );
    return { objectKey: key, sha256: hashBuffer(bytes) };
  }

  /** Open a readable stream over an object. */
  async getStream(bucketClass: BucketClass, key: string): Promise<Readable> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketFor(bucketClass), Key: key }),
    );
    const body = res.Body;
    if (body === undefined || !(body instanceof Readable)) {
      throw new IntegrityError('GetObject returned no readable body', { key });
    }
    return body;
  }

  /**
   * Create a short-lived presigned GET URL after server-side validation.
   * Staging keys and keys outside the tenant are refused. The URL is returned
   * to the caller and is never logged.
   */
  async presignGet(
    tenantId: string,
    key: string,
    opts?: { ttlSeconds?: number },
  ): Promise<string> {
    assertKeyInTenant(tenantId, key);
    const cls = keyClass(key);
    if (cls === 'staging') {
      throw new KeyValidationError('presigned URLs are not issued for staging keys');
    }
    if (cls === 'unknown') {
      throw new KeyValidationError('presigned URLs are not issued for unclassified keys');
    }
    let ttl = this.presignTtlSeconds;
    if (opts?.ttlSeconds !== undefined) {
      if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
        throw new TypeError('ttlSeconds must be a positive integer');
      }
      ttl = Math.min(opts.ttlSeconds, this.presignTtlSeconds);
    }
    const command = new GetObjectCommand({ Bucket: this.evidenceBucket, Key: key });
    return this.presignFn(this.s3, command, { expiresIn: ttl });
  }

  /** Re-hash an object's bytes by streaming, comparing to the expected digest. */
  async verifyObjectHash(
    bucketClass: BucketClass,
    key: string,
    expectedSha256: string,
  ): Promise<{ ok: boolean; actualSha256: string; size: number }> {
    if (!SHA256_HEX_RE.test(expectedSha256)) {
      throw new KeyValidationError('expectedSha256 must be 64 lowercase hex characters');
    }
    const stream = await this.getStream(bucketClass, key);
    const { sha256, size } = await hashStreamToNull(stream);
    return { ok: sha256 === expectedSha256, actualSha256: sha256, size };
  }

  /**
   * Detect the actual protection posture of the evidence bucket. The result's
   * `honest` sentence never claims WORM unless Object Lock is truly enabled.
   */
  async detectBucketProtection(): Promise<BucketProtection> {
    const versioning = await this.s3.send(
      new GetBucketVersioningCommand({ Bucket: this.evidenceBucket }),
    );
    const versioningEnabled = versioning.Status === 'Enabled';

    let objectLockEnabled = false;
    let objectLockMode: string | undefined;
    try {
      const lock = await this.s3.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.evidenceBucket }),
      );
      objectLockEnabled = lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
      objectLockMode = lock.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      // No Object Lock configuration: leave objectLockEnabled = false.
    }

    let honest: string;
    if (objectLockEnabled && versioningEnabled) {
      honest = `Bucket versioning and Object Lock are enabled${
        objectLockMode !== undefined ? ` (${objectLockMode} mode)` : ''
      } (WORM retention applies).`;
    } else if (objectLockEnabled) {
      honest =
        'Object Lock reports enabled but bucket versioning does not: configuration is inconsistent; do not rely on WORM retention until verified.';
    } else if (versioningEnabled) {
      honest =
        'Bucket versioning is enabled but Object Lock is NOT enabled: originals are protected by application logic and IAM policy only (no WORM guarantee).';
    } else {
      honest =
        'Neither bucket versioning nor Object Lock is enabled: originals are protected by application logic and IAM policy only (no WORM guarantee).';
    }

    const result: BucketProtection = { versioningEnabled, objectLockEnabled, honest };
    if (objectLockMode !== undefined) result.objectLockMode = objectLockMode;
    return result;
  }

  private async headOrNull(bucket: string, key: string): Promise<{ size: number } | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: head.ContentLength ?? -1 };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }
}
