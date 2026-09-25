#!/usr/bin/env tsx
/**
 * Re-queue evidence items whose processing never finished.
 *
 *   pnpm tsx scripts/requeue-pending.ts                      # dry run, all tenants
 *   pnpm tsx scripts/requeue-pending.ts -- --commit
 *   pnpm tsx scripts/requeue-pending.ts -- --tenant <uuid> --limit 1000 --commit
 *   pnpm tsx scripts/requeue-pending.ts -- --include-exceptions --commit
 *
 * Why this exists
 * ---------------
 * The instruction to process an item lives only in Redis. The outbox marks a row
 * `dispatched` in the same transaction that enqueues it and keeps it, so nothing
 * re-dispatches. `StalledItemSweeper` is not a substitute: it walks COLLECTION
 * items and re-queues only `collectionFetchItem` or `searchIndex`, never
 * `processExtract` or `processOcr`, and it treats `indexed` as settled. Measured
 * 2026-09-15 against 200,341 pending items, it would have recovered none of them
 * — 197,641 were attachment children with no `collection_items` row at all.
 *
 * What the database does hold is `evidence_items.processingStatus`, which names
 * every unfinished item exactly. This walks that column and re-enqueues the
 * stage each item still needs.
 *
 * Safety
 * ------
 * Dry run by DEFAULT. Nothing is written without `--commit`.
 *
 * Re-running a stage is safe by design. `process-parse.ts:88` early-returns for
 * anything already at or past `parsed`, its child inserts use `skipDuplicates`
 * and its metadata writes are upserts; the index write is an idempotent upsert
 * keyed by evidence id. Erring toward dispatching is the safe direction.
 *
 * Every dedup key carries a fresh token. `(topic, dedupKey)` is unique and
 * dispatched rows are kept, so a key built only from item and version works once
 * ever — the second attempt would be silently dropped by `skipDuplicates` and
 * the item would stay stuck with nothing saying so.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient, withTenantContext } from '@aeg-clouddfir/database';

/** Rows read per page. Cursor paging, so no `in` list and no bind-variable ceiling. */
const PAGE = 500;
/** Outbox rows per insert. Matches the other bulk paths. */
const WRITE_CHUNK = 500;

interface Stage {
  topic: string;
  stage: string;
}

/**
 * The stage an item still needs, from where it stopped AND what it is.
 *
 * Kind matters, and getting it wrong is silent. `process-extract.ts:59` returns
 * immediately for `kind === 'email'` — emails are handled by parse, which writes
 * their text and enqueues the index itself. A first version of this script keyed
 * on status alone and would have fired 4,535 no-op extract jobs at emails on
 * staging: every one would have completed successfully and moved nothing.
 */
function nextStage(status: string, kind: string, mimeType = ''): Stage | null {
  switch (status) {
    case 'pending':
      // Emails are containers: parse reads them and creates their attachments.
      // Everything else goes straight to extract.
      return kind === 'email'
        ? { topic: 'process.parse', stage: 'parse' }
        : { topic: 'process.extract', stage: 'extract' };
    case 'parsed':
      // Only emails reach 'parsed', and their text is already written.
      return { topic: 'search.index', stage: 'index' };
    case 'extracted': // Same cost-class split as process-extract's ocrOutboxRows: images belong
    // on the image lane. Routing them onto process.ocr recreates the blockage
    // the split removed (tens of thousands of images in front of PDFs).
    {
      const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
      return mime.startsWith('image/')
        ? { topic: 'process.ocr.image', stage: 'ocr' }
        : { topic: 'process.ocr', stage: 'ocr' };
    }
    case 'ocr_complete':
    case 'preview_ready':
      return { topic: 'search.index', stage: 'index' };
    case 'exception':
      // Only with --include-exceptions. Start it over from its kind.
      return kind === 'email'
        ? { topic: 'process.parse', stage: 'parse' }
        : { topic: 'process.extract', stage: 'extract' };
    default:
      return null;
  }
}

const HANDLED = ['pending', 'parsed', 'extracted', 'ocr_complete', 'preview_ready'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const commit = has('commit');
  const onlyTenant = arg('tenant');
  const limit = Number(arg('limit') ?? Number.POSITIVE_INFINITY);
  const statuses = [...HANDLED];
  if (has('include-exceptions')) statuses.push('exception');

  const config = loadConfig();
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const token = randomUUID().slice(0, 8);

  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
    return tx.tenant.findMany({ select: { id: true } });
  });
  const targets = onlyTenant ? tenants.filter((t) => t.id === onlyTenant) : tenants;

  console.log(`${commit ? 'COMMIT' : 'DRY RUN'} — statuses: ${statuses.join(', ')}`);
  console.log(`tenants: ${String(targets.length)}, token: ${token}\n`);

  const totals: Record<string, number> = {};
  let written = 0;

  for (const { id: tenantId } of targets) {
    let cursor: string | undefined;
    let seen = 0;

    for (;;) {
      if (seen >= limit) break;
      const page = await withTenantContext(prisma, tenantId, (tx) =>
        tx.evidenceItem.findMany({
          where: { processingStatus: { in: statuses as never } },
          select: { id: true, processingStatus: true, kind: true, mimeType: true },
          take: Math.min(PAGE, limit - seen),
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
        }),
      );
      if (page.length === 0) break;
      cursor = page[page.length - 1]?.id;
      seen += page.length;

      const rows = page.flatMap((item) => {
        const status = String(item.processingStatus);
        const kind = String(item.kind);
        const next = nextStage(status, kind, String(item.mimeType ?? ''));
        if (next === null) return [];
        totals[`${status} (${kind})`] = (totals[`${status} (${kind})`] ?? 0) + 1;
        return [
          {
            tenantId,
            topic: next.topic,
            // Fresh token: a once-ever key would be dropped on the second attempt.
            dedupKey: `${next.stage}:${item.id}:v1:requeue${token}`,
            payload: { tenantId, evidenceItemId: item.id, version: 1 },
          },
        ];
      });

      if (commit) {
        for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
          const batch = rows.slice(i, i + WRITE_CHUNK);
          await withTenantContext(prisma, tenantId, (tx) =>
            tx.outboxEvent.createMany({ data: batch as never }),
          );
          written += batch.length;
        }
      }
    }
  }

  console.log('items found, by where they stopped and what they are:');
  for (const [key, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    const [status = '', kindPart = ''] = key.split(' (');
    const next = nextStage(status, kindPart.replace(')', ''));
    console.log(`  ${key.padEnd(26)} ${String(n).padStart(8)}  -> ${next?.topic ?? '-'}`);
  }
  const found = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(`\ntotal: ${String(found)}`);
  console.log(
    commit
      ? `outbox rows written: ${String(written)} — the worker dispatches them within a minute`
      : 'nothing written. Re-run with --commit to enqueue.',
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
