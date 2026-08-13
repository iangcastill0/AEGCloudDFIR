#!/usr/bin/env node
/**
 * Verify object storage before trusting it with evidence.
 *
 *   node dist/storage-check-cli.js            # read-only probes
 *   node dist/storage-check-cli.js --write    # also round-trip real bytes
 *
 * Reads the CDFIR_S3_* configuration from the environment. Run it where that is
 * already set (e.g. `docker compose exec api`) so no credential is typed on a
 * command line, where it would land in shell history and the process list.
 *
 * Exercises exactly the operations the evidence store performs, so a pass here
 * means the endpoint, region, credentials and bucket policy are right — not that
 * they are merely plausible. Prints the protection posture in the store's own
 * words rather than a friendlier paraphrase.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { EvidenceObjectStore } from './store.js';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}

const checks: Check[] = [];
function record(name: string, status: Check['status'], detail: string): void {
  checks.push({ name, status, detail });
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }[status];
  process.stdout.write(`  [${mark}] ${name}\n         ${detail}\n`);
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    process.stderr.write(`error: ${name} is not set\n`);
    process.exit(2);
  }
  return v;
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return String(err);
}

/**
 * Name plus message, because the name alone loses the part that identifies the
 * fix. A real example: every check reported "AccessDenied", while the message
 * said "... with an explicit deny" — which means an explicit Deny statement is
 * in force and adding an Allow policy will change nothing, since Deny always
 * wins. Truncated because SDK messages can be long, but the leading text is
 * where the cause lives.
 */
function errDetail(err: unknown): string {
  const name = errName(err);
  const msg = err instanceof Error ? err.message : '';
  if (msg.length === 0 || msg === name) return name;
  const trimmed = msg.length > 240 ? `${msg.slice(0, 240)}…` : msg;
  return `${name}: ${trimmed}`;
}

/** Explicit Deny cannot be fixed by granting an Allow — call that out. */
function denyHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  return /explicit deny/i.test(msg)
    ? ' NOTE: an EXPLICIT DENY is in force — an IAM Deny beats any Allow, so adding permissions will not help. Find and remove the Deny (user policies, group policies, or a bucket policy) first.'
    : '';
}

async function main(): Promise<number> {
  const write = process.argv.includes('--write');

  const endpoint = required('CDFIR_S3_ENDPOINT');
  const region = required('CDFIR_S3_REGION');
  const evidenceBucket = required('CDFIR_S3_BUCKET_EVIDENCE');
  const quarantineBucket = required('CDFIR_S3_BUCKET_QUARANTINE');
  const accessKeyId = required('CDFIR_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('CDFIR_S3_SECRET_ACCESS_KEY');
  const forcePathStyle = (process.env['CDFIR_S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false';
  const presignTtlSeconds = Number(process.env['CDFIR_S3_PRESIGN_TTL_SECONDS'] ?? '300');

  process.stdout.write('\nConfiguration (no secrets shown)\n');
  process.stdout.write(`  endpoint          ${endpoint}\n`);
  process.stdout.write(`  region            ${region}\n`);
  process.stdout.write(`  evidence bucket   ${evidenceBucket}\n`);
  process.stdout.write(`  quarantine bucket ${quarantineBucket}\n`);
  process.stdout.write(`  access key id     ${accessKeyId}\n`);
  process.stdout.write(`  secret key        set (${secretAccessKey.length} chars, not shown)\n`);
  process.stdout.write(`  path style        ${String(forcePathStyle)}\n`);
  process.stdout.write(`  presign ttl       ${String(presignTtlSeconds)}s\n\n`);

  // The region is baked into the signature. If it disagrees with the region in
  // the endpoint hostname every request fails, and the error reads as an
  // authentication problem, so flag the mismatch up front.
  const hostRegion = /^https?:\/\/s3\.([a-z0-9-]+)\.wasabisys\.com/.exec(endpoint)?.[1];
  if (hostRegion !== undefined && hostRegion !== region) {
    record(
      'endpoint/region agreement',
      'fail',
      `endpoint names region "${hostRegion}" but CDFIR_S3_REGION is "${region}" — every request will fail signature verification`,
    );
  } else {
    record(
      'endpoint/region agreement',
      hostRegion === undefined ? 'skip' : 'pass',
      hostRegion === undefined
        ? 'endpoint is not a recognised Wasabi regional hostname; cannot cross-check'
        : `endpoint and CDFIR_S3_REGION both say "${region}"`,
    );
  }

  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  // --- reachability: needs s3:ListBucket ---
  for (const [label, bucket] of [
    ['evidence', evidenceBucket],
    ['quarantine', quarantineBucket],
  ] as const) {
    try {
      await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
      record(`${label} bucket reachable (ListBucket)`, 'pass', bucket);
    } catch (err) {
      record(
        `${label} bucket reachable (ListBucket)`,
        'fail',
        `${bucket}: ${errDetail(err)} — check the bucket name, region, and that the policy grants s3:ListBucket on the bucket ARN (not just /*).${denyHint(err)}`,
      );
    }
  }

  // --- multipart visibility: large uploads go through lib-storage ---
  try {
    await s3.send(new ListMultipartUploadsCommand({ Bucket: evidenceBucket, MaxUploads: 1 }));
    record(
      'multipart uploads listable',
      'pass',
      's3:ListBucketMultipartUploads granted; abandoned parts from a failed large upload can be found and aborted',
    );
  } catch (err) {
    record(
      'multipart uploads listable',
      'fail',
      `${errDetail(err)} — grant s3:ListBucketMultipartUploads, or a failed multi-GB upload leaves billable parts you cannot clean up.${denyHint(err)}`,
    );
  }

  // --- the NotFound vs AccessDenied trap ---
  // headOrNull returns null on NotFound and rethrows everything else. Without
  // s3:ListBucket a missing object answers AccessDenied, so stage/verify/promote
  // breaks on every new object.
  const missingKey = `storage-check/definitely-absent-${randomBytes(8).toString('hex')}`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: evidenceBucket, Key: missingKey }));
    record('missing object returns NotFound', 'warn', 'a key that should not exist responded OK');
  } catch (err) {
    const name = errName(err);
    const isNotFound = name === 'NotFound' || name === 'NoSuchKey';
    record(
      'missing object returns NotFound',
      isNotFound ? 'pass' : 'fail',
      isNotFound
        ? 'absent keys answer NotFound, so the store can distinguish "not yet uploaded" from an error'
        : `absent key answered ${errDetail(err)}, not NotFound — the store rethrows anything that is not NotFound, so stage/verify/promote will break on every new object. This is the s3:ListBucket grant.${denyHint(err)}`,
    );
  }

  // --- protection posture, in the store's own words ---
  const store = new EvidenceObjectStore({
    s3,
    evidenceBucket,
    quarantineBucket,
    presignTtlSeconds: Number.isInteger(presignTtlSeconds) && presignTtlSeconds > 0 ? presignTtlSeconds : 300,
  });
  try {
    const p = await store.detectBucketProtection();
    const worm = p.objectLockEnabled && p.versioningEnabled && p.defaultRetentionConfigured;
    record(
      'protection posture',
      worm ? 'pass' : 'warn',
      `versioning=${String(p.versioningEnabled)} objectLock=${String(p.objectLockEnabled)} ` +
        `defaultRetention=${String(p.defaultRetentionConfigured)}` +
        (p.objectLockMode !== undefined ? ` mode=${p.objectLockMode}` : ''),
    );
    process.stdout.write(`\n  Reported verbatim by the platform:\n    "${p.honest}"\n\n`);
  } catch (err) {
    record(
      'protection posture',
      'fail',
      `${errDetail(err)} — grant s3:GetBucketVersioning and s3:GetBucketObjectLockConfiguration, or the platform cannot determine what to claim.${denyHint(err)}`,
    );
  }

  // --- round trip (opt-in: it writes) ---
  if (!write) {
    record(
      'byte round trip',
      'skip',
      're-run with --write to write a small object, read it back and verify its SHA-256',
    );
  } else {
    const payload = randomBytes(4096);
    const expected = createHash('sha256').update(payload).digest('hex');
    const key = `storage-check/roundtrip-${expected.slice(0, 16)}`;
    let wrote = false;
    try {
      await s3.send(new PutObjectCommand({ Bucket: evidenceBucket, Key: key, Body: payload }));
      wrote = true;
      const got = await s3.send(new GetObjectCommand({ Bucket: evidenceBucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const c of got.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      const actual = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
      record(
        'byte round trip',
        actual === expected ? 'pass' : 'fail',
        actual === expected
          ? `4096 bytes written and read back; SHA-256 matches (${expected.slice(0, 16)}…) — nothing transformed the object in transit or at rest`
          : `SHA-256 MISMATCH: wrote ${expected} read ${actual}. Something is transforming objects (server-side compression or encryption?). Do not store evidence here until resolved.`,
      );

      const url = await store.presignGet('00000000-0000-4000-8000-000000000000', key, {
        ttlSeconds: 60,
      }).catch(() => undefined);
      if (url === undefined) {
        // presignGet validates key shape; a scratch key is not tenant-scoped.
        record('presigned URL', 'skip', 'scratch key is not tenant-scoped, so the store declined to presign it (key validation working as intended)');
      } else {
        const res = await fetch(url);
        record(
          'presigned URL fetchable',
          res.ok ? 'pass' : 'fail',
          `HTTP ${String(res.status)} from the presigned URL`,
        );
      }
    } catch (err) {
      record('byte round trip', 'fail', `${errDetail(err)}${denyHint(err)}`);
    } finally {
      if (wrote) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: evidenceBucket, Key: key }));
          record('cleanup', 'pass', 'test object deleted');
        } catch (err) {
          record(
            'cleanup',
            'warn',
            `could not delete ${key}: ${errDetail(err)}. Expected if a default Object Lock retention applies — the object is immutable until retention expires. It is 4 KiB; leave it.`,
          );
        }
      }
    }
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  process.stdout.write(
    `\n${String(checks.length)} checks: ${String(checks.filter((c) => c.status === 'pass').length)} pass, ` +
      `${String(failed.length)} fail, ${String(warned.length)} warn, ` +
      `${String(checks.filter((c) => c.status === 'skip').length)} skip\n`,
  );
  if (failed.length > 0) {
    process.stdout.write('\nDo not store evidence here until the failures above are resolved.\n');
    return 1;
  }
  if (warned.length > 0) {
    process.stdout.write(
      '\nUsable, but read the warnings — they describe protection you may believe you have and do not.\n',
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Never interpolate config into output: the endpoint is fine, the secret is not.
    process.stderr.write(`storage check failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
