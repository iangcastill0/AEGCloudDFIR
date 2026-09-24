#!/usr/bin/env tsx
/* eslint-disable no-console -- This is an operator CLI, not a worker process.
   The worker bans console so that service output goes through the structured
   logger; here the terminal IS the output, and pino would make it unreadable. */
/**
 * Ask storage, one object at a time, whether the evidence we recorded is still
 * there.
 *
 *   # inside the worker container, which has node_modules and the right env
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/sweep-missing-objects.ts
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/sweep-missing-objects.ts --concurrency=16
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/sweep-missing-objects.ts --limit=2000
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/sweep-missing-objects.ts --after=<last id printed>
 *
 * READ ONLY. It sends HEAD requests and prints. It writes nothing — not to the
 * database, not to storage, not to a file. There is no --commit, because there
 * is nothing to commit.
 *
 * Run it from `/app` INSIDE the container, not from a repo root on a host:
 * `@aws-sdk/client-s3` is a dependency of `packages/evidence`, and a require
 * from the wrong directory fails to resolve it. Measured 2026-09-22.
 *
 * Why this exists
 * ---------------
 * On 2026-09-22 a 130 GiB native export of 434,910 items ended with
 * `32 item(s) failed verification`. All 32 had an `evidence_blobs` row whose
 * object Wasabi answers NoSuchKey for. The bytes had been gone for at least
 * twelve days and nothing in the product said so, because the only code that
 * touched those objects recorded the loss as a malware scan failure.
 *
 * Reading 130 GiB to discover 32 absent keys is not a way to watch a store. A
 * HEAD transfers no bytes and answers the same question, so the whole store
 * can be checked in roughly an hour instead of a day.
 *
 * What it checks, and what it does not
 * ------------------------------------
 * Every row in `evidence_blobs` — the ORIGINALS, the bytes a court would be
 * shown. Each key is HEADed in the bucket its storageClass names, and the
 * length storage reports is compared with the length the row records.
 *
 * Deliberately NOT checked: derivatives (extracted text, OCR, previews),
 * manifests, production and export output. Every one of those can be rebuilt
 * from an original; an original can be rebuilt from nothing. Including them
 * would multiply the request count for a smaller problem.
 *
 * A HEAD proves a key exists and how long it is. It does NOT prove the bytes
 * still hash to the recorded sha256 — that needs a full read. This tool
 * reports only what it measured.
 *
 * Safety on a real store
 * ----------------------
 * 480,989 objects on production as of 2026-09-22.
 *
 *  - Bounded concurrency, default 8, hard cap 32. Wasabi is serving the live
 *    worker pool at the same time; this is a background check, not a race.
 *  - Blobs come out of Postgres in id order, in pages, so memory stays flat
 *    whatever the row count is.
 *  - Restartable rather than clever: the last id of every page is printed and
 *    `--after=<id>` starts from there. Nothing is stored between runs, so a
 *    killed sweep costs only the page it was in the middle of.
 *  - `--limit` takes a sample first, before committing to the whole store.
 */
import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient, withTenantContext } from '@aeg-clouddfir/database';
import { Redis } from 'ioredis';
import pino from 'pino';
import { BullMqEnqueuer } from './bullmq-enqueuer.js';
import { buildWorkerContext } from './context.js';
import { checkBlob, pooled, type SweepBlob, type SweepVerdict } from './object-sweep.js';

/** Rows pulled from Postgres per page. Independent of storage concurrency. */
const DB_PAGE_SIZE = 2_000;
const DEFAULT_CONCURRENCY = 8;
/** Above this the sweep starts competing with the live worker pool. */
const MAX_CONCURRENCY = 32;

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function intFlag(name: string, fallback: number, max: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return Math.min(n, max);
}

interface Finding {
  tenantId: string;
  tenantSlug: string;
  blob: SweepBlob;
  verdict: SweepVerdict;
  actualSize?: number;
  error?: string;
}

async function main(): Promise<void> {
  const concurrency = intFlag('concurrency', DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
  const limit = intFlag('limit', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const after = flag('after') ?? '';
  const onlyTenant = flag('tenant') ?? '';

  const config = loadConfig();
  const log = pino({ level: 'error' });
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const redis = new Redis(config.CDFIR_REDIS_URL, { maxRetriesPerRequest: null });
  const enqueuer = new BullMqEnqueuer(redis);
  prismaRef = prisma;
  redisRef = redis;
  enqueuerRef = enqueuer;
  const ctx = buildWorkerContext(config, { prisma, redis, log, enqueuer });

  console.log('READ ONLY — this sweep HEADs objects and prints. It writes nothing.\n');
  console.log(`  evidence bucket    ${config.CDFIR_S3_BUCKET_EVIDENCE}`);
  console.log(`  quarantine bucket  ${config.CDFIR_S3_BUCKET_QUARANTINE}`);
  console.log(`  concurrency        ${String(concurrency)}`);
  if (after !== '') console.log(`  resuming after     ${after}`);
  if (onlyTenant !== '') console.log(`  tenant             ${onlyTenant}`);
  if (limit !== Number.MAX_SAFE_INTEGER) console.log(`  limit              ${String(limit)}`);
  console.log('');

  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
    return tx.tenant.findMany({ select: { id: true, slug: true }, orderBy: { id: 'asc' } });
  });
  const scoped = onlyTenant === '' ? tenants : tenants.filter((t) => t.id === onlyTenant);
  if (scoped.length === 0) {
    console.log('No tenants matched. Nothing to check.');
    await shutdown();
    return;
  }

  const counts: Record<SweepVerdict, number> = {
    present: 0,
    missing: 0,
    size_mismatch: 0,
    error: 0,
  };
  const findings: Finding[] = [];
  let checked = 0;
  const startedAt = Date.now();

  for (const tenant of scoped) {
    // Cursor by id, not OFFSET. OFFSET re-scans every row it skips, which turns
    // a linear sweep over half a million rows into a quadratic one.
    // --after seeds the FIRST tenant only; later tenants start from the top.
    let cursor = tenant === scoped[0] ? after : '';
    for (;;) {
      if (checked >= limit) break;
      const page = await withTenantContext(prisma, tenant.id, (tx) =>
        tx.evidenceBlob.findMany({
          where: { id: { gt: cursor } },
          select: { id: true, sha256: true, size: true, objectKey: true, storageClass: true },
          orderBy: { id: 'asc' },
          take: Math.min(DB_PAGE_SIZE, limit - checked),
        }),
      );
      if (page.length === 0) break;

      await pooled(page, concurrency, async (blob) => {
        const result = await checkBlob(ctx.store, blob);
        counts[result.verdict] += 1;
        if (result.verdict !== 'present') {
          findings.push({
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            blob,
            verdict: result.verdict,
            ...(result.actualSize !== undefined ? { actualSize: result.actualSize } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          });
        }
        if (result.verdict === 'missing') {
          console.log(`MISSING  ${blob.objectKey}  (blob ${blob.id}, tenant ${tenant.slug})`);
        }
      });

      checked += page.length;
      cursor = page[page.length - 1]?.id ?? cursor;
      const rate = checked / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(
        `  ...${String(checked)} checked, ${String(counts.missing)} missing, ` +
          `${String(counts.size_mismatch)} size mismatch, ${String(counts.error)} error ` +
          `(${rate.toFixed(0)}/s) — resume with --after=${cursor}`,
      );
    }
  }

  await report(prisma, findings, counts, checked);
  await shutdown();
}

/**
 * Print what was found, and for anything absent, which evidence items and
 * collections depend on it. A key on its own is not actionable; the item and
 * the matter it belongs to are.
 */
async function report(
  prisma: ReturnType<typeof createPrismaClient>,
  findings: Finding[],
  counts: Record<SweepVerdict, number>,
  checked: number,
): Promise<void> {
  console.log('');
  console.log(`checked ${String(checked)} evidence blob(s)`);
  console.log(`  present        ${String(counts.present)}`);
  console.log(`  MISSING        ${String(counts.missing)}`);
  console.log(`  size mismatch  ${String(counts.size_mismatch)}`);
  console.log(`  error          ${String(counts.error)}   (UNKNOWN, not counted as missing)`);

  const errors = findings.filter((f) => f.verdict === 'error');
  if (errors.length > 0) {
    const byError = new Map<string, number>();
    for (const f of errors) byError.set(f.error ?? '', (byError.get(f.error ?? '') ?? 0) + 1);
    console.log('\nErrors (storage did not give a usable answer):');
    for (const [message, n] of [...byError].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n)}x  ${message}`);
    }
    console.log('  These objects are neither proven present nor proven gone. Re-run them.');
  }

  const mismatches = findings.filter((f) => f.verdict === 'size_mismatch');
  if (mismatches.length > 0) {
    console.log('\nSize mismatches (object is there, but not the length we recorded):');
    for (const f of mismatches) {
      console.log(
        `  ${f.blob.objectKey}  recorded ${String(f.blob.size)} bytes, ` +
          `storage says ${String(f.actualSize ?? -1)}`,
      );
    }
  }

  const missing = findings.filter((f) => f.verdict === 'missing');
  if (missing.length === 0) {
    console.log('\nEvery object checked is present at the recorded length.');
    console.log('A HEAD does not re-hash the bytes, so this is existence and size, not integrity.');
    return;
  }

  console.log(`\n${String(missing.length)} MISSING object(s). What depends on them:\n`);
  const byCollection = new Map<string, number>();
  for (const f of missing) {
    const items = await withTenantContext(prisma, f.tenantId, async (tx) => {
      const rows = await tx.evidenceItem.findMany({
        where: { blobId: f.blob.id },
        select: {
          id: true,
          name: true,
          malwareStatus: true,
          processingStatus: true,
          collectionId: true,
          custodian: { select: { email: true } },
        },
      });
      // EvidenceItem has no `collection` relation field, so the names come
      // from a second lookup rather than an include.
      const ids = [...new Set(rows.map((r) => r.collectionId).filter((id) => id !== null))];
      const collections =
        ids.length === 0
          ? []
          : await tx.collection.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true },
            });
      const names = new Map(collections.map((c) => [c.id, c.name]));
      return rows.map((r) => ({
        ...r,
        collectionName:
          r.collectionId === null
            ? '(no collection)'
            : (names.get(r.collectionId) ?? r.collectionId),
      }));
    });

    console.log(`  ${f.blob.objectKey}   [tenant ${f.tenantSlug}]`);
    console.log(`    blob ${f.blob.id}  sha256 ${f.blob.sha256}  ${String(f.blob.size)} bytes`);
    if (items.length === 0) {
      console.log('    no evidence item references this blob (orphan row)');
    }
    for (const item of items) {
      byCollection.set(item.collectionName, (byCollection.get(item.collectionName) ?? 0) + 1);
      console.log(`    item ${item.id}  "${item.name}"  custodian ${item.custodian?.email ?? '-'}`);
      console.log(
        `      collection "${item.collectionName}"  ` +
          `processing=${item.processingStatus}  malware=${item.malwareStatus}`,
      );
    }
    console.log('');
  }

  console.log('By collection:');
  for (const [name, n] of [...byCollection].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${name}`);
  }

  console.log(
    '\nThese items have no bytes. They cannot be scanned, previewed, produced or\n' +
      'exported, and any export that includes them reports them as failed\n' +
      'verification. If the evidence bucket has versioning enabled the bytes may\n' +
      'still be recoverable through ListObjectVersions — the application\n' +
      'credentials are denied that call, so it is a console or admin-key job.',
  );
}

/**
 * Close in this order or the process hangs after printing its report: the
 * enqueuer borrows the same Redis connection, so quitting Redis first leaves
 * BullMQ holding the event loop open with nothing to close.
 */
async function shutdown(): Promise<void> {
  await enqueuerRef?.close();
  await redisRef?.quit();
  await prismaRef?.$disconnect();
}

let enqueuerRef: BullMqEnqueuer | undefined;
let redisRef: Redis | undefined;
let prismaRef: ReturnType<typeof createPrismaClient> | undefined;

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    void shutdown().finally(() => {
      process.exit(1);
    });
  });
