import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCopyCommand,
  type CompletedPart,
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
  /**
   * Whether the bucket carries a DEFAULT retention rule.
   *
   * This is load-bearing, not informational. Enabling Object Lock on a bucket
   * only makes retention *possible*; it locks nothing by itself. Objects acquire
   * retention either from a bucket default or from a per-object retention set at
   * upload time — and this application never sets per-object retention (it holds
   * no s3:PutObjectRetention grant, deliberately). So on a bucket with Object
   * Lock enabled and no default rule, not one object is actually retained.
   */
  defaultRetentionConfigured: boolean;
  /** Days or years from the bucket default rule, when one exists. */
  defaultRetentionDays?: number;
  defaultRetentionYears?: number;
  /** Honest, human-readable statement — never claims WORM unless objects are genuinely retained. */
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

/**
 * Build a Content-Disposition value. Quotes and control characters are stripped
 * rather than escaped: the filename ends up inside a signed URL, and a header
 * that can be broken out of is a header-injection primitive.
 */
function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200);
  return `attachment; filename="${safe}"`;
}

function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * S3-compatible APIs cap a single-part server-side copy at 5 GiB. Anything
 * larger must be copied part by part with UploadPartCopy, or promotion fails
 * *after* the bytes have already been staged — the worst possible place for it,
 * since all the transfer work is done by then.
 */
const MAX_SINGLE_PART_COPY_BYTES = 5 * 1024 ** 3;
/** Part size for multipart copy. 512 MiB keeps a 10 GiB object at 20 parts. */
const COPY_PART_BYTES = 512 * 1024 ** 2;
/** S3 allows at most 10,000 parts; scale the part size up rather than exceed it. */
const MAX_COPY_PARTS = 10_000;

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

    await this.copySized(this.evidenceBucket, sourceStagingKey, destBucket, destKey, expected.size);

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
  /**
   * Presign a GET.
   *
   * `downloadFilename` sets ResponseContentDisposition so the browser saves the
   * object instead of rendering it. The HTML `download` attribute cannot do this
   * — browsers ignore it on cross-origin URLs, and presigned URLs always point
   * at the storage host, so a manifest.json opened from the app renders as text
   * unless the disposition is signed into the URL itself.
   */
  async presignGet(
    tenantId: string,
    key: string,
    opts?: { ttlSeconds?: number; downloadFilename?: string },
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
    const command = new GetObjectCommand({
      Bucket: this.evidenceBucket,
      Key: key,
      ...(opts?.downloadFilename !== undefined
        ? { ResponseContentDisposition: contentDisposition(opts.downloadFilename) }
        : {}),
    });
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
   * List objects under a prefix, paginating to completion.
   *
   * A production run writes an unknown number of files (volumes, images, load
   * files, manifests), so a download endpoint cannot hardcode their names — it
   * has to enumerate what the worker actually produced. Returns keys sorted so
   * output ordering is stable between calls.
   */
  async listUnder(
    bucketClass: BucketClass,
    prefix: string,
  ): Promise<{ key: string; size: number }[]> {
    const bucket = this.bucketFor(bucketClass);
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key !== undefined) out.push({ key: o.Key, size: o.Size ?? 0 });
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  /**
   * Cheap reachability + credential probe for readiness checks.
   *
   * Uses ListObjectsV2 with MaxKeys=1 rather than a HEAD on a known key: it
   * needs no object to exist, and it exercises the same s3:ListBucket grant the
   * store depends on to tell "not uploaded yet" from "denied". Throws the
   * underlying SDK error so the caller can report the cause rather than a
   * generic failure.
   */
  async checkReachable(): Promise<void> {
    await this.s3.send(new ListObjectsV2Command({ Bucket: this.evidenceBucket, MaxKeys: 1 }));
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
    let defaultRetentionDays: number | undefined;
    let defaultRetentionYears: number | undefined;
    try {
      const lock = await this.s3.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.evidenceBucket }),
      );
      objectLockEnabled = lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
      const rule = lock.ObjectLockConfiguration?.Rule?.DefaultRetention;
      objectLockMode = rule?.Mode;
      defaultRetentionDays = rule?.Days;
      defaultRetentionYears = rule?.Years;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      // No Object Lock configuration: leave objectLockEnabled = false.
    }

    // A default rule needs a mode AND a period. A mode with neither Days nor
    // Years retains nothing, so treat it as unconfigured rather than assuming a
    // period the bucket never stated.
    const defaultRetentionConfigured =
      objectLockMode !== undefined &&
      ((defaultRetentionDays ?? 0) > 0 || (defaultRetentionYears ?? 0) > 0);

    const period =
      defaultRetentionYears !== undefined && defaultRetentionYears > 0
        ? `${defaultRetentionYears} year(s)`
        : defaultRetentionDays !== undefined && defaultRetentionDays > 0
          ? `${defaultRetentionDays} day(s)`
          : 'unspecified period';

    let honest: string;
    if (objectLockEnabled && versioningEnabled && defaultRetentionConfigured) {
      honest = `Bucket versioning and Object Lock are enabled with a default retention rule (${String(objectLockMode)} mode, ${period}) (WORM retention applies).`;
    } else if (objectLockEnabled && versioningEnabled) {
      // The trap this method exists to catch: Object Lock on, nothing retained.
      honest =
        'Bucket versioning and Object Lock are enabled but NO default retention rule is configured, and this application does not set per-object retention: no object is actually retained (no WORM guarantee). Configure a bucket default retention rule.';
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

    const result: BucketProtection = {
      versioningEnabled,
      objectLockEnabled,
      defaultRetentionConfigured,
      honest,
    };
    if (objectLockMode !== undefined) result.objectLockMode = objectLockMode;
    if (defaultRetentionDays !== undefined) result.defaultRetentionDays = defaultRetentionDays;
    if (defaultRetentionYears !== undefined) result.defaultRetentionYears = defaultRetentionYears;
    return result;
  }

  /**
   * Server-side copy that works above the 5 GiB single-part ceiling.
   *
   * Under the limit this is a plain CopyObject. Over it, the object is copied
   * range by range with UploadPartCopy. Either way no bytes travel through this
   * process — the copy happens inside the storage provider.
   *
   * Parts are copied sequentially rather than in parallel: a failed multipart
   * copy must be aborted to avoid leaving parts that are billed and invisible,
   * and sequential execution keeps that cleanup path simple and deterministic.
   * Copy throughput is the provider's, not ours, so the wall-clock cost is
   * modest (a 10 GiB object is 20 parts).
   */
  private async copySized(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string,
    size: number,
  ): Promise<void> {
    const copySource = encodeCopySource(sourceBucket, sourceKey);

    if (size <= MAX_SINGLE_PART_COPY_BYTES) {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: destBucket,
          Key: destKey,
          CopySource: copySource,
          MetadataDirective: 'COPY',
        }),
      );
      return;
    }

    // Grow the part size for very large objects so the part count stays within
    // the 10,000 limit instead of failing partway through.
    const partSize = Math.max(COPY_PART_BYTES, Math.ceil(size / MAX_COPY_PARTS));

    const created = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: destBucket, Key: destKey }),
    );
    const uploadId = created.UploadId;
    if (uploadId === undefined || uploadId.length === 0) {
      throw new IntegrityError('CreateMultipartUpload returned no UploadId', { key: destKey });
    }

    try {
      const parts: CompletedPart[] = [];
      let partNumber = 1;
      for (let start = 0; start < size; start += partSize) {
        // CopySourceRange is inclusive at both ends.
        const end = Math.min(start + partSize, size) - 1;
        const res = await this.s3.send(
          new UploadPartCopyCommand({
            Bucket: destBucket,
            Key: destKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource: copySource,
            CopySourceRange: `bytes=${String(start)}-${String(end)}`,
          }),
        );
        const etag = res.CopyPartResult?.ETag;
        if (etag === undefined || etag.length === 0) {
          throw new IntegrityError('UploadPartCopy returned no ETag', {
            key: destKey,
            partNumber,
          });
        }
        parts.push({ ETag: etag, PartNumber: partNumber });
        partNumber += 1;
      }

      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: destBucket,
          Key: destKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      // Abandoned parts are billed and do not appear in a bucket listing, so
      // aborting matters even though the promotion is already failing. Abort is
      // best-effort: surfacing its error would mask the real cause.
      try {
        await this.s3.send(
          new AbortMultipartUploadCommand({
            Bucket: destBucket,
            Key: destKey,
            UploadId: uploadId,
          }),
        );
      } catch {
        // fall through and rethrow the original failure
      }
      throw err;
    }
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
