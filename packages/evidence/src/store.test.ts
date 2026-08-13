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
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrityError, KeyValidationError } from './errors.js';
import { originalKey, quarantineKey, stagingKey } from './objectKeys.js';
import { EvidenceObjectStore } from './store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const STAGING_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EVIDENCE_BUCKET = 'cdfir-evidence';
const QUARANTINE_BUCKET = 'cdfir-quarantine';

// sha256('hello world')
const HELLO_SHA = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
// sha256('abc')
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const s3 = new S3Client({ region: 'us-east-1' });
const s3Mock = mockClient(s3);

function makeStore(presignFn?: ConstructorParameters<typeof EvidenceObjectStore>[0]['presignFn']) {
  return new EvidenceObjectStore({
    s3,
    evidenceBucket: EVIDENCE_BUCKET,
    quarantineBucket: QUARANTINE_BUCKET,
    presignTtlSeconds: 300,
    ...(presignFn !== undefined ? { presignFn } : {}),
  });
}

function notFound(name = 'NotFound'): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function asBody(readable: Readable): GetObjectCommandOutput['Body'] {
  return readable as unknown as GetObjectCommandOutput['Body'];
}

beforeEach(() => {
  s3Mock.reset();
});

describe('stageStream', () => {
  it('uploads to a staging key while hashing and counting bytes', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
    const store = makeStore();

    const result = await store.stageStream(TENANT, Readable.from([Buffer.from('hello world')]));

    expect(result.sha256).toBe(HELLO_SHA);
    expect(result.size).toBe(11);
    expect(result.stagingKey).toMatch(new RegExp(`^tenants/${TENANT}/staging/[0-9a-f-]{36}$`));

    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts.length).toBe(1);
    expect(puts[0]!.args[0].input.Bucket).toBe(EVIDENCE_BUCKET);
    expect(puts[0]!.args[0].input.Key).toBe(result.stagingKey);
  });
});

describe('promoteToOriginal', () => {
  const srcKey = stagingKey(TENANT, STAGING_UUID);
  const destKey = originalKey(TENANT, HELLO_SHA);

  it('runs head -> copy -> verify -> delete with the expected keys', async () => {
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: destKey })
      .rejectsOnce(notFound())
      .resolves({ ContentLength: 11 });
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: srcKey })
      .resolves({ ContentLength: 11 });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const store = makeStore();
    const result = await store.promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: 11 });

    expect(result).toEqual({ objectKey: destKey, bucket: EVIDENCE_BUCKET });

    const copies = s3Mock.commandCalls(CopyObjectCommand);
    expect(copies.length).toBe(1);
    expect(copies[0]!.args[0].input).toMatchObject({
      Bucket: EVIDENCE_BUCKET,
      Key: destKey,
      CopySource: `${EVIDENCE_BUCKET}/${srcKey}`,
    });

    const deletes = s3Mock.commandCalls(DeleteObjectCommand);
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.args[0].input).toMatchObject({ Bucket: EVIDENCE_BUCKET, Key: srcKey });
  });

  it('routes to the quarantine bucket when quarantine is requested', async () => {
    const qKey = quarantineKey(TENANT, HELLO_SHA);
    s3Mock
      .on(HeadObjectCommand, { Bucket: QUARANTINE_BUCKET, Key: qKey })
      .rejectsOnce(notFound())
      .resolves({ ContentLength: 11 });
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: srcKey })
      .resolves({ ContentLength: 11 });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const store = makeStore();
    const result = await store.promoteToOriginal(
      TENANT,
      srcKey,
      { sha256: HELLO_SHA, size: 11 },
      { quarantine: true },
    );

    expect(result).toEqual({ objectKey: qKey, bucket: QUARANTINE_BUCKET });
    expect(s3Mock.commandCalls(CopyObjectCommand)[0]!.args[0].input.Bucket).toBe(QUARANTINE_BUCKET);
  });

  it('throws IntegrityError on size mismatch and does NOT delete staging', async () => {
    s3Mock.on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: destKey }).rejects(notFound());
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: srcKey })
      .resolves({ ContentLength: 999 });

    const store = makeStore();
    await expect(
      store.promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: 11 }),
    ).rejects.toThrow(IntegrityError);

    expect(s3Mock.commandCalls(DeleteObjectCommand).length).toBe(0);
    expect(s3Mock.commandCalls(CopyObjectCommand).length).toBe(0);
  });

  it('is idempotent: existing destination with matching size skips the copy and deletes staging', async () => {
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: destKey })
      .resolves({ ContentLength: 11 });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const store = makeStore();
    const result = await store.promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: 11 });

    expect(result).toEqual({ objectKey: destKey, bucket: EVIDENCE_BUCKET });
    expect(s3Mock.commandCalls(CopyObjectCommand).length).toBe(0);
    const deletes = s3Mock.commandCalls(DeleteObjectCommand);
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.args[0].input.Key).toBe(srcKey);
  });

  it('refuses an existing destination whose size differs', async () => {
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: destKey })
      .resolves({ ContentLength: 42 });

    const store = makeStore();
    await expect(
      store.promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: 11 }),
    ).rejects.toThrow(IntegrityError);
    expect(s3Mock.commandCalls(DeleteObjectCommand).length).toBe(0);
  });

  it('rejects non-staging and cross-tenant source keys', async () => {
    const store = makeStore();
    await expect(
      store.promoteToOriginal(TENANT, destKey, { sha256: HELLO_SHA, size: 11 }),
    ).rejects.toThrow(KeyValidationError);
    await expect(
      store.promoteToOriginal(TENANT, stagingKey(OTHER_TENANT, STAGING_UUID), {
        sha256: HELLO_SHA,
        size: 11,
      }),
    ).rejects.toThrow(KeyValidationError);
    expect(s3Mock.calls().length).toBe(0);
  });
});

describe('putDerivative and putManifest', () => {
  it('uploads a buffer derivative with hash and size', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const store = makeStore();
    const result = await store.putDerivative(
      TENANT,
      STAGING_UUID,
      'text',
      1,
      'extracted.txt',
      Buffer.from('abc'),
      'text/plain',
    );
    expect(result.sha256).toBe(ABC_SHA);
    expect(result.size).toBe(3);
    expect(result.objectKey).toBe(
      `tenants/${TENANT}/derivatives/${STAGING_UUID}/text/1/extracted.txt`,
    );
    const put = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put.ContentType).toBe('text/plain');
    expect(put.Key).toBe(result.objectKey);
  });

  it('uploads a stream derivative, hashing while streaming', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
    const store = makeStore();
    const result = await store.putDerivative(
      TENANT,
      STAGING_UUID,
      'pdf',
      2,
      'render.pdf',
      Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      'application/pdf',
    );
    expect(result.sha256).toBe(HELLO_SHA);
    expect(result.size).toBe(11);
  });

  it('stores a manifest as canonical JSON bytes', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const store = makeStore();
    const json = '{"schemaVersion":"1"}';
    const result = await store.putManifest(TENANT, STAGING_UUID, json);
    expect(result.objectKey).toBe(`tenants/${TENANT}/manifests/${STAGING_UUID}/manifest.json`);
    const put = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put.ContentType).toBe('application/json');
  });
});

describe('getStream and verifyObjectHash', () => {
  it('verifies a matching object hash', async () => {
    const key = originalKey(TENANT, ABC_SHA);
    s3Mock
      .on(GetObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: key })
      .resolves({ Body: asBody(Readable.from([Buffer.from('abc')])) });
    const store = makeStore();
    const result = await store.verifyObjectHash('evidence', key, ABC_SHA);
    expect(result).toEqual({ ok: true, actualSha256: ABC_SHA, size: 3 });
  });

  it('reports a hash mismatch without throwing', async () => {
    const key = originalKey(TENANT, HELLO_SHA);
    s3Mock
      .on(GetObjectCommand)
      .resolves({ Body: asBody(Readable.from([Buffer.from('tampered')])) });
    const store = makeStore();
    const result = await store.verifyObjectHash('evidence', key, HELLO_SHA);
    expect(result.ok).toBe(false);
    expect(result.actualSha256).not.toBe(HELLO_SHA);
  });

  it('reads from the quarantine bucket for quarantine class', async () => {
    const key = quarantineKey(TENANT, ABC_SHA);
    s3Mock
      .on(GetObjectCommand, { Bucket: QUARANTINE_BUCKET, Key: key })
      .resolves({ Body: asBody(Readable.from([Buffer.from('abc')])) });
    const store = makeStore();
    const stream = await store.getStream('quarantine', key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
  });
});

describe('presignGet', () => {
  const validKey = originalKey(TENANT, ABC_SHA);

  it('signs a valid tenant key with the configured TTL', async () => {
    const presignFn = vi.fn(
      async (_c: S3Client, _cmd: GetObjectCommand, _o: { expiresIn: number }) =>
        'https://signed.test/url',
    );
    const store = makeStore(presignFn);
    const url = await store.presignGet(TENANT, validKey);
    expect(url).toBe('https://signed.test/url');
    expect(presignFn).toHaveBeenCalledTimes(1);
    expect(presignFn.mock.calls[0]![2]).toEqual({ expiresIn: 300 });
    expect(presignFn.mock.calls[0]![1].input).toMatchObject({
      Bucket: EVIDENCE_BUCKET,
      Key: validKey,
    });
  });

  it('caps the requested TTL at presignTtlSeconds', async () => {
    const presignFn = vi.fn(
      async (_c: S3Client, _cmd: GetObjectCommand, _o: { expiresIn: number }) => 'https://u',
    );
    const store = makeStore(presignFn);
    await store.presignGet(TENANT, validKey, { ttlSeconds: 99999 });
    expect(presignFn.mock.calls[0]![2]).toEqual({ expiresIn: 300 });
    await store.presignGet(TENANT, validKey, { ttlSeconds: 60 });
    expect(presignFn.mock.calls[1]![2]).toEqual({ expiresIn: 60 });
  });

  it('rejects foreign-tenant keys without calling the presigner', async () => {
    const presignFn = vi.fn(
      async (_c: S3Client, _cmd: GetObjectCommand, _o: { expiresIn: number }) => 'https://u',
    );
    const store = makeStore(presignFn);
    await expect(store.presignGet(TENANT, originalKey(OTHER_TENANT, ABC_SHA))).rejects.toThrow(
      KeyValidationError,
    );
    expect(presignFn).not.toHaveBeenCalled();
  });

  it('rejects staging-class keys without calling the presigner', async () => {
    const presignFn = vi.fn(
      async (_c: S3Client, _cmd: GetObjectCommand, _o: { expiresIn: number }) => 'https://u',
    );
    const store = makeStore(presignFn);
    await expect(store.presignGet(TENANT, stagingKey(TENANT, STAGING_UUID))).rejects.toThrow(
      /staging/,
    );
    expect(presignFn).not.toHaveBeenCalled();
  });

  it('rejects traversal and unclassified keys without calling the presigner', async () => {
    const presignFn = vi.fn(
      async (_c: S3Client, _cmd: GetObjectCommand, _o: { expiresIn: number }) => 'https://u',
    );
    const store = makeStore(presignFn);
    await expect(
      store.presignGet(TENANT, `tenants/${TENANT}/originals/../../${OTHER_TENANT}/x`),
    ).rejects.toThrow(KeyValidationError);
    await expect(store.presignGet(TENANT, `tenants/${TENANT}/mystery/x`)).rejects.toThrow(
      KeyValidationError,
    );
    expect(presignFn).not.toHaveBeenCalled();
  });
});

describe('detectBucketProtection', () => {
  it('reports WORM only when versioning, Object Lock AND a default retention rule exist', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 30 } },
      },
    });
    const store = makeStore();
    const result = await store.detectBucketProtection();
    expect(result.versioningEnabled).toBe(true);
    expect(result.objectLockEnabled).toBe(true);
    expect(result.objectLockMode).toBe('COMPLIANCE');
    expect(result.defaultRetentionConfigured).toBe(true);
    expect(result.defaultRetentionDays).toBe(30);
    expect(result.honest).toContain('WORM retention applies');
    expect(result.honest).toContain('30 day(s)');
  });

  it('reports a years-based default retention period', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Years: 7 } },
      },
    });
    const result = await makeStore().detectBucketProtection();
    expect(result.defaultRetentionConfigured).toBe(true);
    expect(result.defaultRetentionYears).toBe(7);
    expect(result.honest).toContain('GOVERNANCE mode, 7 year(s)');
    expect(result.honest).toContain('WORM retention applies');
  });

  // The regression this guards: Object Lock enabled on the bucket makes retention
  // POSSIBLE, not automatic. Objects get retention from a bucket default or from
  // a per-object value at upload — and this application never sets per-object
  // retention. So with no default rule, nothing is retained, and claiming WORM
  // would be false.
  it('does NOT claim WORM when Object Lock is enabled but no default retention rule exists', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
    });
    const result = await makeStore().detectBucketProtection();
    expect(result.objectLockEnabled).toBe(true);
    expect(result.defaultRetentionConfigured).toBe(false);
    expect(result.honest).not.toContain('WORM retention applies');
    expect(result.honest).toContain('NO default retention rule');
    expect(result.honest).toContain('no object is actually retained');
  });

  it('treats a retention rule with a mode but no period as unconfigured', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE' } },
      },
    });
    const result = await makeStore().detectBucketProtection();
    // A mode with neither Days nor Years retains nothing.
    expect(result.defaultRetentionConfigured).toBe(false);
    expect(result.honest).not.toContain('WORM retention applies');
  });

  it('treats a zero-length retention period as unconfigured', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).resolves({
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 0 } },
      },
    });
    const result = await makeStore().detectBucketProtection();
    expect(result.defaultRetentionConfigured).toBe(false);
    expect(result.honest).not.toContain('WORM retention applies');
  });

  it('never claims WORM when Object Lock is absent', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({});
    s3Mock
      .on(GetObjectLockConfigurationCommand)
      .rejects(notFound('ObjectLockConfigurationNotFoundError'));
    const store = makeStore();
    const result = await store.detectBucketProtection();
    expect(result.versioningEnabled).toBe(false);
    expect(result.objectLockEnabled).toBe(false);
    expect(result.objectLockMode).toBeUndefined();
    expect(result.defaultRetentionConfigured).toBe(false);
    expect(result.honest).not.toContain('WORM retention applies');
    expect(result.honest).toContain('application logic and IAM policy only');
  });

  it('is honest about versioning-only buckets', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock
      .on(GetObjectLockConfigurationCommand)
      .rejects(notFound('ObjectLockConfigurationNotFoundError'));
    const store = makeStore();
    const result = await store.detectBucketProtection();
    expect(result.versioningEnabled).toBe(true);
    expect(result.objectLockEnabled).toBe(false);
    expect(result.honest).toContain('Object Lock is NOT enabled');
    expect(result.honest).not.toContain('WORM retention applies');
  });

  it('propagates unexpected errors instead of guessing', async () => {
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    s3Mock.on(GetObjectLockConfigurationCommand).rejects(notFound('AccessDenied'));
    const store = makeStore();
    await expect(store.detectBucketProtection()).rejects.toThrow('AccessDenied');
  });
});

/**
 * S3-compatible APIs cap a single-part server-side copy at 5 GiB, while
 * CDFIR_UPLOAD_MAX_BYTES defaults to 10 GiB. Before this, an upload in that
 * range staged successfully — staging uses multipart — and then failed at
 * promotion, after every byte had already been transferred.
 */
describe('promoteToOriginal — objects above the 5 GiB single-part copy limit', () => {
  const srcKey = stagingKey(TENANT, STAGING_UUID);
  const destKey = originalKey(TENANT, HELLO_SHA);
  const GIB = 1024 ** 3;
  const FIVE_GIB = 5 * GIB;

  function arrangeHeads(size: number): void {
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: destKey })
      .rejectsOnce(notFound())
      .resolves({ ContentLength: size });
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: srcKey })
      .resolves({ ContentLength: size });
    s3Mock.on(DeleteObjectCommand).resolves({});
  }

  function arrangeMultipartOk(): void {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
    let n = 0;
    s3Mock.on(UploadPartCopyCommand).callsFake(() => {
      n += 1;
      return Promise.resolve({ CopyPartResult: { ETag: `"etag-${String(n)}"` } });
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
  }

  it('still uses a single CopyObject exactly at the 5 GiB boundary', async () => {
    arrangeHeads(FIVE_GIB);
    s3Mock.on(CopyObjectCommand).resolves({});
    await makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: FIVE_GIB });

    expect(s3Mock.commandCalls(CopyObjectCommand).length).toBe(1);
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand).length).toBe(0);
  });

  it('switches to multipart copy one byte over the boundary', async () => {
    arrangeHeads(FIVE_GIB + 1);
    arrangeMultipartOk();
    await makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size: FIVE_GIB + 1 });

    expect(s3Mock.commandCalls(CopyObjectCommand).length).toBe(0);
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand).length).toBe(1);
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand).length).toBe(1);
  });

  it('copies a 10 GiB object as contiguous, gapless, inclusive ranges', async () => {
    const size = 10 * GIB;
    arrangeHeads(size);
    arrangeMultipartOk();
    await makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size });

    const calls = s3Mock.commandCalls(UploadPartCopyCommand);
    expect(calls.length).toBe(20); // 10 GiB at 512 MiB parts

    let expectedStart = 0;
    calls.forEach((c, i) => {
      const input = c.args[0].input;
      expect(input.PartNumber).toBe(i + 1);
      expect(input.UploadId).toBe('upload-1');
      expect(input.CopySource).toBe(`${EVIDENCE_BUCKET}/${srcKey}`);
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(input.CopySourceRange));
      expect(m).not.toBeNull();
      const start = Number(m![1]);
      const end = Number(m![2]);
      // No gaps and no overlaps: each part resumes exactly where the last ended.
      expect(start).toBe(expectedStart);
      expect(end).toBeGreaterThanOrEqual(start);
      expectedStart = end + 1;
    });
    // The final range must land exactly on the last byte, not past it.
    expect(expectedStart).toBe(size);
  });

  it('sends the parts to CompleteMultipartUpload in order with their ETags', async () => {
    const size = 6 * GIB;
    arrangeHeads(size);
    arrangeMultipartOk();
    await makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size });

    const complete = s3Mock.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input;
    const parts = complete.MultipartUpload?.Parts ?? [];
    expect(parts.length).toBe(12);
    parts.forEach((part, i) => {
      expect(part.PartNumber).toBe(i + 1);
      expect(part.ETag).toBe(`"etag-${String(i + 1)}"`);
    });
  });

  it('keeps the part count within the 10,000 limit by growing the part size', async () => {
    // 8 TiB at a fixed 512 MiB part size would need 16,384 parts and be rejected.
    const size = 8 * 1024 ** 4;
    arrangeHeads(size);
    arrangeMultipartOk();
    await makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size });

    const calls = s3Mock.commandCalls(UploadPartCopyCommand);
    expect(calls.length).toBeLessThanOrEqual(10_000);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('aborts the upload when a part fails, so orphaned parts are not left billing', async () => {
    const size = 6 * GIB;
    arrangeHeads(size);
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
    s3Mock
      .on(UploadPartCopyCommand)
      .resolvesOnce({ CopyPartResult: { ETag: '"etag-1"' } })
      .rejects(new Error('network blip'));
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    await expect(
      makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size }),
    ).rejects.toThrow('network blip');

    const aborts = s3Mock.commandCalls(AbortMultipartUploadCommand);
    expect(aborts.length).toBe(1);
    expect(aborts[0]!.args[0].input).toMatchObject({
      Bucket: EVIDENCE_BUCKET,
      Key: destKey,
      UploadId: 'upload-1',
    });
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand).length).toBe(0);
  });

  it('surfaces the original failure even if the abort also fails', async () => {
    const size = 6 * GIB;
    arrangeHeads(size);
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
    s3Mock.on(UploadPartCopyCommand).rejects(new Error('the real cause'));
    s3Mock.on(AbortMultipartUploadCommand).rejects(new Error('abort also failed'));

    // The abort error must not mask why the promotion failed.
    await expect(
      makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size }),
    ).rejects.toThrow('the real cause');
  });

  it('rejects a part copy that returns no ETag rather than completing a corrupt object', async () => {
    const size = 6 * GIB;
    arrangeHeads(size);
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
    s3Mock.on(UploadPartCopyCommand).resolves({});
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    await expect(
      makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size }),
    ).rejects.toThrow(IntegrityError);
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand).length).toBe(0);
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand).length).toBe(1);
  });

  it('fails closed when CreateMultipartUpload returns no UploadId', async () => {
    const size = 6 * GIB;
    arrangeHeads(size);
    s3Mock.on(CreateMultipartUploadCommand).resolves({});

    await expect(
      makeStore().promoteToOriginal(TENANT, srcKey, { sha256: HELLO_SHA, size }),
    ).rejects.toThrow(IntegrityError);
    expect(s3Mock.commandCalls(UploadPartCopyCommand).length).toBe(0);
  });

  it('routes a large infected object into the quarantine bucket', async () => {
    const size = 6 * GIB;
    const qKey = quarantineKey(TENANT, HELLO_SHA);
    s3Mock
      .on(HeadObjectCommand, { Bucket: QUARANTINE_BUCKET, Key: qKey })
      .rejectsOnce(notFound())
      .resolves({ ContentLength: size });
    s3Mock
      .on(HeadObjectCommand, { Bucket: EVIDENCE_BUCKET, Key: srcKey })
      .resolves({ ContentLength: size });
    s3Mock.on(DeleteObjectCommand).resolves({});
    arrangeMultipartOk();

    const result = await makeStore().promoteToOriginal(
      TENANT,
      srcKey,
      { sha256: HELLO_SHA, size },
      { quarantine: true },
    );

    expect(result).toEqual({ objectKey: qKey, bucket: QUARANTINE_BUCKET });
    const created = s3Mock.commandCalls(CreateMultipartUploadCommand)[0]!.args[0].input;
    expect(created.Bucket).toBe(QUARANTINE_BUCKET);
    // Source is still the evidence bucket's staging key.
    const part = s3Mock.commandCalls(UploadPartCopyCommand)[0]!.args[0].input;
    expect(part.CopySource).toBe(`${EVIDENCE_BUCKET}/${srcKey}`);
  });
});
