import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { BackupError, backupObjectKey, runBackup } from './backup.js';

const BUCKET = 'gdf-backups';
const s3 = new S3Client({ region: 'us-east-1' });
const s3Mock = mockClient(s3);

const AT = new Date('2026-08-13T23:33:12.000Z');
const PAYLOAD = Buffer.from('PGDMP fake custom-format dump payload');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/** Arrange a successful upload whose read-back returns `body`. */
function arrange(body: Buffer = PAYLOAD, contentLength = body.length): void {
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: contentLength });
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([body]) as never });
}

function opts(overrides: Partial<Parameters<typeof runBackup>[0]> = {}) {
  return {
    s3,
    bucket: BUCKET,
    source: Readable.from([PAYLOAD]),
    now: () => AT,
    ...overrides,
  };
}

beforeEach(() => {
  s3Mock.reset();
});

describe('backupObjectKey', () => {
  it('partitions by day and carries a shell-safe timestamp', () => {
    expect(backupObjectKey(AT)).toBe('postgres/2026-08-13/cdfir-2026-08-13T23-33-12-000Z.dump');
  });

  it('carries no colon, which would need quoting in shells and URLs', () => {
    // The '.' in '.dump' is fine; ':' from an ISO timestamp is not.
    const key = backupObjectKey(AT);
    expect(key).not.toContain(':');
    expect(key.endsWith('.dump')).toBe(true);
  });

  it('sorts chronologically as a plain string, so listings are ordered', () => {
    const earlier = backupObjectKey(new Date('2026-08-13T01:00:00.000Z'));
    const later = backupObjectKey(new Date('2026-08-13T23:00:00.000Z'));
    const nextDay = backupObjectKey(new Date('2026-08-14T00:00:00.000Z'));
    expect(earlier < later).toBe(true);
    expect(later < nextDay).toBe(true);
  });
});

describe('runBackup — success path', () => {
  it('uploads the dump, hashes it in flight, and records a manifest', async () => {
    arrange();
    const result = await runBackup(opts());

    expect(result.sha256).toBe(PAYLOAD_SHA);
    expect(result.sizeBytes).toBe(PAYLOAD.length);
    expect(result.verified).toBe(true);
    expect(result.objectKey).toBe('postgres/2026-08-13/cdfir-2026-08-13T23-33-12-000Z.dump');
    expect(result.manifestKey).toBe(`${result.objectKey}.manifest.json`);
  });

  it('writes the manifest as JSON with the fields a restore needs', async () => {
    arrange();
    await runBackup(
      opts({
        describeDatabase: () =>
          Promise.resolve({ pgVersion: 'PostgreSQL 16.14', migration: '20260813000005_x' }),
      }),
    );

    const puts = s3Mock.commandCalls(PutObjectCommand);
    const manifestPut = puts.find((c) => String(c.args[0].input.Key).endsWith('.manifest.json'));
    expect(manifestPut).toBeDefined();
    expect(manifestPut!.args[0].input.ContentType).toBe('application/json');

    const manifest = JSON.parse(String(manifestPut!.args[0].input.Body)) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      sha256: PAYLOAD_SHA,
      sizeBytes: PAYLOAD.length,
      dumpFormat: 'custom',
      pgVersion: 'PostgreSQL 16.14',
      migration: '20260813000005_x',
      verified: true,
      startedAt: '2026-08-13T23:33:12.000Z',
    });
  });

  it('records verified=false when verification is skipped, rather than implying it', async () => {
    arrange();
    const result = await runBackup(opts({ verify: false }));
    expect(result.verified).toBe(false);
    expect(result.manifest.verified).toBe(false);
    // No read-back was attempted.
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('degrades provenance to "unknown" instead of failing the backup', async () => {
    arrange();
    const result = await runBackup(
      opts({ describeDatabase: () => Promise.reject(new Error('permission denied')) }),
    );
    // A metadata query failure must not cost us a real backup.
    expect(result.manifest.pgVersion).toBe('unknown');
    expect(result.manifest.migration).toBe('unknown');
    expect(result.verified).toBe(true);
  });
});

describe('runBackup — refuses to record a bad backup', () => {
  it('rejects an empty dump instead of storing a zero-byte "success"', async () => {
    arrange(Buffer.alloc(0), 0);
    // pg_dump producing nothing is a failure that looks like success in a
    // bucket listing, which is the most dangerous shape a backup bug can take.
    await expect(runBackup(opts({ source: Readable.from([]) }))).rejects.toThrow(BackupError);
    // and no manifest is written to advertise it
    const manifests = s3Mock
      .commandCalls(PutObjectCommand)
      .filter((c) => String(c.args[0].input.Key).endsWith('.manifest.json'));
    expect(manifests.length).toBe(0);
  });

  it('fails when the stored object size does not match what was sent', async () => {
    arrange(PAYLOAD, PAYLOAD.length - 5);
    await expect(runBackup(opts())).rejects.toThrow(/bytes but/);
  });

  it('fails when the read-back hash differs from what was written', async () => {
    // Same length, different bytes: only a hash catches this.
    const corrupted = Buffer.from('X'.repeat(PAYLOAD.length));
    expect(corrupted.length).toBe(PAYLOAD.length);
    arrange(corrupted, PAYLOAD.length);
    await expect(runBackup(opts())).rejects.toThrow(/verification failed/);
  });

  it('does not write a manifest when verification fails', async () => {
    arrange(Buffer.from('Y'.repeat(PAYLOAD.length)), PAYLOAD.length);
    await expect(runBackup(opts())).rejects.toThrow(/verification failed/);
    const manifests = s3Mock
      .commandCalls(PutObjectCommand)
      .filter((c) => String(c.args[0].input.Key).endsWith('.manifest.json'));
    // A manifest is the record that a good backup exists; it must not appear
    // for one that failed its own integrity check.
    expect(manifests.length).toBe(0);
  });

  it('propagates a mid-stream pg_dump failure instead of storing a truncated dump', async () => {
    arrange();
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('pg_dump exited unexpectedly'));
      },
    });
    await expect(runBackup(opts({ source: failing }))).rejects.toThrow(
      /pg_dump exited unexpectedly/,
    );
  });

  it('rejects a stream that is not a pg_dump custom-format file', async () => {
    arrange();
    // The realistic case: pg_dump wrote an error to stdout, or the wrong command
    // ran, and the bytes are text rather than a dump.
    const notADump = Readable.from([Buffer.from('ERROR:  permission denied for table x')]);
    await expect(runBackup(opts({ source: notADump }))).rejects.toThrow(/PGDMP/);
  });

  it('accepts a stream that does start with the PGDMP magic', async () => {
    const realish = Buffer.concat([Buffer.from('PGDMP'), Buffer.from('...body...')]);
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: realish.length });
    s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([realish]) as never });
    const result = await runBackup(opts({ source: Readable.from([realish]) }));
    expect(result.verified).toBe(true);
    expect(result.sizeBytes).toBe(realish.length);
  });

  it('checks the magic even when the stream arrives one byte at a time', async () => {
    // A chunked stream must not slip past the guard by splitting the header.
    const chunks = 'NOPE!rest-of-body'.split('').map((c) => Buffer.from(c));
    arrange();
    await expect(runBackup(opts({ source: Readable.from(chunks) }))).rejects.toThrow(/PGDMP/);
  });

  it('refuses to run without a bucket', async () => {
    await expect(runBackup(opts({ bucket: '' }))).rejects.toThrow(BackupError);
  });

  it('fails when the verification read returns no body', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: PAYLOAD.length });
    s3Mock.on(GetObjectCommand).resolves({});
    await expect(runBackup(opts())).rejects.toThrow(/no body/);
  });
});
