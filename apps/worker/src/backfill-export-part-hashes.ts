#!/usr/bin/env tsx
/* eslint-disable no-console -- Operator CLI: the terminal IS the output here,
   and pino would make a progress report unreadable. */
/**
 * Give an already-produced export a digest for each of its archive parts.
 *
 *   # inside the worker container, which has node_modules and the right env
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx \
 *     apps/worker/src/backfill-export-part-hashes.ts --export <uuid>
 *   ... --export <uuid> --commit
 *
 * Dry run by DEFAULT. Nothing is written without `--commit`.
 *
 * Why this exists
 * ---------------
 * `putDerivative` has always returned a SHA-256 for every archive part, and
 * `runNativeExport` used to throw it away. Exports produced before that was
 * fixed have no `export_parts` rows, so a recipient who downloads 65 files has
 * no way to tell a truncated part from a good one short of unzipping all of it
 * and hashing 434,878 items.
 *
 * This re-reads each part from object storage and hashes it. There is no
 * cheaper way: the digest was never recorded, and S3 ETags are not SHA-256 and
 * are not even MD5 for multipart uploads.
 *
 * Cost
 * ----
 * It reads every byte of the export. For the 130 GiB export this was written
 * for that is 130 GiB of reads and a few hours. It is read-only against object
 * storage, it holds nothing in memory (the bytes are streamed through the
 * hasher), and it can be interrupted and re-run — parts already recorded are
 * skipped.
 *
 * Honest limit
 * ------------
 * A digest computed now proves what is in the bucket NOW. It is not evidence
 * about what was written at export time, and it cannot detect corruption that
 * happened before this ran. The audit event says so, and says it was
 * backfilled rather than recorded at production.
 */
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@aeg-clouddfir/config';
import { appendAuditEvent, createPrismaClient, withTenantContext } from '@aeg-clouddfir/database';
import {
  EvidenceObjectStore,
  archivePartFilename,
  derivativeKey,
  derivativeTypeFor,
} from '@aeg-clouddfir/evidence';

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n.toFixed(1)} ${units[u] ?? 'B'}`;
}

async function main(): Promise<void> {
  const commit = has('commit');
  const exportId = arg('export');
  if (exportId === undefined) {
    console.error('usage: backfill-export-part-hashes.ts --export <uuid> [--commit]');
    process.exit(2);
  }

  const config = loadConfig();
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const store = new EvidenceObjectStore({
    s3: new S3Client({
      endpoint: config.CDFIR_S3_ENDPOINT,
      region: config.CDFIR_S3_REGION,
      forcePathStyle: config.CDFIR_S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.CDFIR_S3_ACCESS_KEY_ID,
        secretAccessKey: config.CDFIR_S3_SECRET_ACCESS_KEY,
      },
    }),
    evidenceBucket: config.CDFIR_S3_BUCKET_EVIDENCE,
    quarantineBucket: config.CDFIR_S3_BUCKET_QUARANTINE,
    presignTtlSeconds: config.CDFIR_S3_PRESIGN_TTL_SECONDS,
  });

  console.log(
    commit ? 'COMMIT — digests will be written\n' : 'DRY RUN — nothing will be written\n',
  );

  // Platform context to find the export's tenant; everything after is tenant-scoped.
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
    return tx.export.findUnique({
      where: { id: exportId },
      select: {
        id: true,
        tenantId: true,
        name: true,
        status: true,
        outputPrefix: true,
        kind: true,
      },
    });
  });
  if (row === null) {
    console.log('No such export.');
    await prisma.$disconnect();
    return;
  }
  if (row.status !== 'ready') {
    console.log(`Export is ${row.status}, not ready. Nothing to hash.`);
    await prisma.$disconnect();
    return;
  }
  console.log(`${row.name}  (${row.id})`);

  const existing = await withTenantContext(prisma, row.tenantId, (tx) =>
    tx.exportPart.findMany({
      where: { exportId: row.id },
      select: { partNumber: true },
      orderBy: { partNumber: 'asc' },
    }),
  );
  const already = new Set(existing.map((p) => p.partNumber));
  if (already.size > 0)
    console.log(`${String(already.size)} part(s) already recorded; skipping those.`);

  // The parts are not listed anywhere, so they are walked until one is missing.
  // That is the same convention the API uses to rebuild keys, and it is why a
  // gap in the middle would end the walk early — see the check after the loop.
  let partNumber = 1;
  let hashed = 0;
  let bytesTotal = 0;
  for (;;) {
    // Extension and derivative type follow the export's kind. A PST export's
    // parts are `.pst` under `pst-archive`, so hardcoding either would hash
    // nothing, report "no such part", and quietly declare the export complete
    // with zero digests recorded.
    const filename = archivePartFilename(row.kind, partNumber);
    // Same key builder the worker wrote with and the API reads with, so a
    // typo here cannot quietly hash the wrong object.
    const key = derivativeKey(
      row.tenantId,
      row.id,
      derivativeTypeFor(row.kind),
      partNumber,
      filename,
    );

    if (already.has(partNumber)) {
      partNumber += 1;
      continue;
    }

    let stream;
    try {
      stream = await store.getStream('evidence', key);
    } catch {
      break; // no such part: the export ends here
    }

    const hasher = createHash('sha256');
    let size = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hasher.update(buf);
      size += buf.byteLength;
    }
    const sha256 = hasher.digest('hex');
    hashed += 1;
    bytesTotal += size;
    console.log(`  part ${String(partNumber).padStart(3, '0')}  ${human(size)}  ${sha256}`);

    if (commit) {
      await withTenantContext(prisma, row.tenantId, async (tx) => {
        await tx.exportPart.upsert({
          where: { exportId_partNumber: { exportId: row.id, partNumber } },
          create: {
            tenantId: row.tenantId,
            exportId: row.id,
            partNumber,
            objectKey: key,
            sha256,
            sizeBytes: BigInt(size),
          },
          update: { objectKey: key, sha256, sizeBytes: BigInt(size) },
        });
        // Said out loud: this digest describes the object as it is today, not
        // as it was when the export was produced.
        await appendAuditEvent(tx, {
          tenantId: row.tenantId,
          action: 'export.part_digest_backfilled',
          targetType: 'export',
          targetId: row.id,
          actorDisplay: 'operator script',
          summary: { partNumber, sha256, sizeBytes: size, computedAt: new Date().toISOString() },
        });
      });
    }
    partNumber += 1;
  }

  console.log(`\nhashed ${String(hashed)} part(s), ${human(bytesTotal)}`);
  if (hashed === 0 && already.size === 0) {
    console.log('Found no archive parts at all. Check the export produced a native archive.');
  }
  if (!commit) console.log('Nothing written. Re-run with --commit.');

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
