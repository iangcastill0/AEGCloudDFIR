#!/usr/bin/env node
/**
 * Fetch a backup from the bucket and verify it against its manifest.
 *
 *   node dist/restore-cli.js --list
 *   node dist/restore-cli.js --key postgres/2026-08-13/cdfir-....dump > restore.dump
 *
 * Deliberately does NOT run pg_restore. It writes the verified dump to stdout
 * and stops, so restoring is an explicit act by an operator who has chosen the
 * target database. A tool that restores automatically is one fat-fingered flag
 * away from overwriting a live database with yesterday's copy.
 *
 * The hash is checked against the manifest BEFORE any bytes reach stdout, so a
 * corrupted backup cannot be piped into pg_restore.
 */
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import type { BackupManifest } from './backup.js';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    process.stderr.write(`error: ${name} is not set\n`);
    process.exit(2);
  }
  return v;
}

function makeClient(): { s3: S3Client; bucket: string } {
  const bucket = required('CDFIR_BACKUP_S3_BUCKET');
  return {
    bucket,
    s3: new S3Client({
      endpoint: required('CDFIR_S3_ENDPOINT'),
      region: required('CDFIR_S3_REGION'),
      forcePathStyle: (process.env['CDFIR_S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
      credentials: {
        accessKeyId: required('CDFIR_BACKUP_S3_ACCESS_KEY_ID'),
        secretAccessKey: required('CDFIR_BACKUP_S3_SECRET_ACCESS_KEY'),
      },
    }),
  };
}

async function readAll(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function list(s3: S3Client, bucket: string): Promise<number> {
  // Keys sort chronologically, so a plain listing is already newest-last.
  let token: string | undefined;
  const keys: { key: string; size: number }[] = [];
  do {
    const page: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'postgres/', ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key !== undefined && o.Key.endsWith('.dump')) {
        keys.push({ key: o.Key, size: o.Size ?? 0 });
      }
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);

  if (keys.length === 0) {
    process.stderr.write('no backups found\n');
    return 1;
  }
  keys.sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const k of keys) {
    process.stdout.write(`${k.key}\t${String(k.size)} bytes\n`);
  }
  process.stderr.write(`\n${String(keys.length)} backup(s); newest is last.\n`);
  return 0;
}

async function fetchVerified(s3: S3Client, bucket: string, key: string): Promise<number> {
  const manifestKey = `${key}.manifest.json`;
  const manifestRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
  const manifest = JSON.parse((await readAll(manifestRes.Body)).toString('utf8')) as BackupManifest;

  process.stderr.write(
    `manifest: sha256=${manifest.sha256} size=${String(manifest.sizeBytes)} ` +
      `pg=${manifest.pgVersion} migration=${manifest.migration}\n`,
  );

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // Buffered rather than streamed to stdout: the hash must be confirmed before
  // a single byte is emitted, or a corrupt dump could already be inside
  // pg_restore by the time the mismatch is discovered.
  const bytes = await readAll(obj.Body);
  const actual = createHash('sha256').update(bytes).digest('hex');

  if (actual !== manifest.sha256 || bytes.length !== manifest.sizeBytes) {
    process.stderr.write(
      `INTEGRITY FAILURE — not emitting the dump.\n` +
        `  manifest: sha256=${manifest.sha256} size=${String(manifest.sizeBytes)}\n` +
        `  actual:   sha256=${actual} size=${String(bytes.length)}\n`,
    );
    return 1;
  }

  process.stderr.write(`verified OK (${String(bytes.length)} bytes). Writing dump to stdout.\n`);
  // Await the flush. process.exit() does NOT drain stdout, so writing and
  // exiting truncates the dump at one pipe buffer (64 KiB) — producing a
  // backup that verifies and then fails in pg_restore with "end of file".
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { s3, bucket } = makeClient();

  if (argv.includes('--list')) {
    try {
      return await list(s3, bucket);
    } finally {
      s3.destroy();
    }
  }

  const keyIdx = argv.indexOf('--key');
  const key = keyIdx >= 0 ? argv[keyIdx + 1] : undefined;
  if (key === undefined || key.length === 0) {
    process.stderr.write(
      'usage:\n' +
        '  restore-cli --list\n' +
        '  restore-cli --key <objectKey> > restore.dump\n\n' +
        'Then restore explicitly, against a database you have chosen:\n' +
        '  pg_restore --clean --if-exists -U cdfir_migrator -d <target> restore.dump\n',
    );
    return 2;
  }
  try {
    return await fetchVerified(s3, bucket, key);
  } finally {
    s3.destroy();
  }
}

main().then(
  (code) => {
    // exitCode rather than exit(): the process ends once the event loop and
    // stdout have drained, so nothing already written can be lost.
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`restore failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
