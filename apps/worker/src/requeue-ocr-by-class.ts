#!/usr/bin/env tsx
/* eslint-disable no-console -- Operator CLI: the terminal IS the output here,
   and pino would make a progress report unreadable. */
/**
 * Move already-queued image OCR jobs onto the image lane.
 *
 *   # inside the worker container, which has node_modules and the right env
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/requeue-ocr-by-class.ts
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/requeue-ocr-by-class.ts --commit
 *
 * It lives here rather than in scripts/ for the same reason
 * backfill-folder-names.ts does: bullmq and ioredis are dependencies of this
 * app, not of the repo root, so a static import does not resolve from scripts/.
 *
 * Dry run by DEFAULT. Nothing moves without `--commit`.
 *
 * Why this exists
 * ---------------
 * Splitting `process.ocr` into a document lane and an image lane only routes
 * work enqueued AFTER the split. Everything already waiting stays on the old
 * queue, which on the production host was 135,629 jobs — roughly 90,000 of
 * them images sitting in front of the PDFs that actually yield text.
 *
 * This is a scheduling fix, not a correctness one. Both queues have workers, so
 * jobs left behind still run; they just keep blocking each other. Nothing is
 * lost if this is never run, and nothing is lost if it is interrupted.
 *
 * Safety
 * ------
 * The BullMQ jobId is preserved, and a jobId is unique per queue, so a second
 * run cannot create a duplicate: `add` with an existing id is a no-op. A job is
 * removed from the old queue only AFTER it has been added to the new one, so a
 * crash in between leaves a copy rather than a hole.
 *
 * Only `waiting` jobs are touched. An active job is mid-OCR and moving it would
 * orphan a running tesseract; it will finish on its own.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient } from '@aeg-clouddfir/database';

const PAGE = 1_000;

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

interface JobLike {
  id?: string;
  name: string;
  data: { evidenceItemId?: string };
  opts: Record<string, unknown>;
  remove: () => Promise<unknown>;
}

async function main(): Promise<void> {
  const commit = has('commit');
  const limit = Number(arg('limit', String(Number.MAX_SAFE_INTEGER)));
  const config = loadConfig();
  const redis = new Redis(config.CDFIR_REDIS_URL, { maxRetriesPerRequest: null });
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);

  const from = new Queue('process.ocr', { connection: redis });
  const to = new Queue('process.ocr.image', { connection: redis });

  console.log(commit ? 'COMMIT — jobs will be moved\n' : 'DRY RUN — nothing will be moved\n');
  console.log(`waiting on process.ocr:       ${String(await from.getWaitingCount())}`);
  console.log(`waiting on process.ocr.image: ${String(await to.getWaitingCount())}\n`);

  let scanned = 0;
  let moved = 0;
  let skippedDocuments = 0;
  let unknown = 0;
  // Walk from the BACK. Moving a job shortens the list, so paging forward from
  // 0 would skip the job that slides into the index just vacated.
  let cursor = await from.getWaitingCount();

  while (cursor > 0 && scanned < limit) {
    const start = Math.max(0, cursor - PAGE);
    const jobs = (await from.getJobs(['waiting'], start, cursor - 1)) as unknown as JobLike[];
    if (jobs.length === 0) break;
    cursor = start;

    const ids = jobs.map((j) => j.data.evidenceItemId).filter((v): v is string => v !== undefined);
    // Platform context, not tenant: this walks every tenant's queue at once and
    // only ever reads a mime type.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      return tx.evidenceItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, mimeType: true },
      });
    });
    const mimeById = new Map(rows.map((r) => [r.id, r.mimeType]));

    for (const job of jobs) {
      scanned += 1;
      const itemId = job.data.evidenceItemId;
      const mime = itemId === undefined ? undefined : mimeById.get(itemId);
      if (mime === undefined) {
        unknown += 1;
        continue; // item deleted, or a payload shape this script does not know
      }
      if (!mime.split(';')[0]?.trim().toLowerCase().startsWith('image/')) {
        skippedDocuments += 1;
        continue;
      }
      moved += 1;
      if (!commit) continue;
      // Add first, remove second. A crash between them leaves a duplicate that
      // the shared dedup key collapses, rather than losing the job entirely.
      await to.add(job.name, job.data, { ...job.opts, jobId: job.id });
      await job.remove();
    }
    process.stdout.write(`\rscanned ${String(scanned)}, image jobs ${String(moved)}`);
  }

  console.log(`\n\nscanned            ${String(scanned)}`);
  console.log(`moved to image lane ${String(moved)}`);
  console.log(`left as documents   ${String(skippedDocuments)}`);
  console.log(`unknown items       ${String(unknown)}`);
  if (!commit) console.log('\nNothing moved. Re-run with --commit.');

  await from.close();
  await to.close();
  await redis.quit();
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
