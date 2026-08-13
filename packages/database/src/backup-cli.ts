#!/usr/bin/env node
/**
 * Stream a PostgreSQL dump from stdin into the backup bucket, verified.
 *
 *   docker exec cdfir-postgres-1 pg_dump -Fc -U cdfir_migrator cdfir \
 *     | docker compose exec -T worker node dist/backup-cli.js
 *
 * The dump arrives on stdin rather than being produced here on purpose:
 * pg_dump refuses to run against a server newer than itself, and the postgres
 * container already ships the exactly-matching pg_dump. Taking it from there
 * makes a version mismatch impossible and keeps the client out of this image.
 *
 * Credentials come from CDFIR_BACKUP_S3_* — a separate, delete-less identity
 * from the application's own. The endpoint and region are shared with
 * CDFIR_S3_* because it is the same provider and region.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { BackupError, runBackup } from './backup.js';

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    process.stderr.write(`error: ${name} is not set\n`);
    process.exit(2);
  }
  return v;
}

async function describeDatabase(): Promise<{ pgVersion: string; migration: string }> {
  const url = process.env['CDFIR_DATABASE_URL'];
  if (url === undefined || url.length === 0) throw new Error('CDFIR_DATABASE_URL is not set');
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const v = await prisma.$queryRaw<{ version: string }[]>`SELECT version() AS version`;
    const m = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`;
    return {
      pgVersion: v[0]?.version ?? 'unknown',
      migration: m[0]?.migration_name ?? 'unknown',
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<number> {
  const bucket = required('CDFIR_BACKUP_S3_BUCKET');
  const accessKeyId = required('CDFIR_BACKUP_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('CDFIR_BACKUP_S3_SECRET_ACCESS_KEY');
  const endpoint = required('CDFIR_S3_ENDPOINT');
  const region = required('CDFIR_S3_REGION');
  const verify = !process.argv.includes('--no-verify');

  if (process.stdin.isTTY) {
    process.stderr.write(
      'error: no dump on stdin. Pipe pg_dump into this command:\n' +
        '  docker exec cdfir-postgres-1 pg_dump -Fc -U cdfir_migrator cdfir | ... backup-cli.js\n',
    );
    return 2;
  }

  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: (process.env['CDFIR_S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  });

  process.stdout.write(`backing up to ${bucket} (verify=${String(verify)})\n`);
  const result = await runBackup({
    s3,
    bucket,
    source: process.stdin,
    now: () => new Date(),
    describeDatabase,
    verify,
  });

  process.stdout.write(
    [
      `  object     ${result.objectKey}`,
      `  manifest   ${result.manifestKey}`,
      `  size       ${String(result.sizeBytes)} bytes`,
      `  sha256     ${result.sha256}`,
      `  verified   ${result.verified ? 'yes — re-read and re-hashed' : 'NO (--no-verify)'}`,
      `  pg         ${result.manifest.pgVersion}`,
      `  migration  ${result.manifest.migration}`,
      '',
    ].join('\n'),
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Never interpolate config: the endpoint is harmless, the secret is not.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`backup failed: ${msg}\n`);
    if (!(err instanceof BackupError)) {
      process.stderr.write('(this was not an integrity failure — check connectivity and IAM)\n');
    }
    process.exit(1);
  },
);
