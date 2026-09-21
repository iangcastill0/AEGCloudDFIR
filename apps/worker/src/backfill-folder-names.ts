#!/usr/bin/env tsx
/* eslint-disable no-console -- This is an operator CLI, not a worker process.
   The worker bans console so that service output goes through the structured
   logger; here the terminal IS the output, and pino would make it unreadable. */
/**
 * Give collected Outlook emails their real folder names.
 *
 *   # inside the worker container, which has node_modules and the right env
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/backfill-folder-names.ts
 *   docker exec -w /app cdfir-worker-1 ./node_modules/.bin/tsx apps/worker/src/backfill-folder-names.ts --commit
 *
 * Dry run by DEFAULT. Nothing is written without `--commit`.
 *
 * Why this is needed
 * ------------------
 * `collection-fetch-item.ts` stores `meta?.folderId` in `EmailMetadata.folder`,
 * so Graph collections carry an opaque id like
 * `AAMkADY0ZDM5NzQzLTBkNmQtNDU4NS05NmJh...` where PST imports carry a readable
 * path like `Top of Personal Folders/bailey-s/Calendar`. Review therefore cannot
 * group a mailbox into Inbox / Sent / Drafts.
 *
 * The names are not recoverable from our own data — the collections were run
 * with `email.folderIds: null`, meaning "every folder", so no folder list was
 * recorded. They have to come from the provider, which means the connector must
 * be freshly authorised. Measured 2026-09-16: 36 opaque ids across 2 mailboxes
 * covering 211,990 emails, and `connector_secrets` held 0 rows, so a reconnect
 * comes first.
 *
 * Search is updated with one `_update_by_query` per folder, NOT by re-indexing.
 * A re-index rebuilds the whole document from ~12 queries plus an object-storage
 * download; for a one-field change across 211,990 documents that is hours. See
 * the same reasoning in `addCaseToCollection`.
 */
import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient, withTenantContext } from '@aeg-clouddfir/database';
import { Redis } from 'ioredis';
import pino from 'pino';
import { BullMqEnqueuer } from './bullmq-enqueuer.js';
import { buildWorkerContext } from './context.js';
import { buildConnectorsForAccount, requireEmail } from './connector-factory.js';

const has = (f: string): boolean => process.argv.includes(`--${f}`);

interface Mailbox {
  tenantId: string;
  connectorAccountId: string;
  custodianId: string;
  externalId: string;
  email: string;
  folderIds: string[];
  emails: number;
}

async function main(): Promise<void> {
  const commit = has('commit');
  const config = loadConfig();
  const log = pino({ level: 'warn' });
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const redis = new Redis(config.CDFIR_REDIS_URL, { maxRetriesPerRequest: null });
  const enqueuer = new BullMqEnqueuer(redis);
  prismaRef = prisma;
  redisRef = redis;
  enqueuerRef = enqueuer;
  const ctx = buildWorkerContext(config, { prisma, redis, log, enqueuer });

  console.log(
    commit ? 'COMMIT — changes will be written\n' : 'DRY RUN — nothing will be written\n',
  );

  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
    return tx.tenant.findMany({ select: { id: true } });
  });

  // Group the opaque folder ids by the mailbox they belong to. A folder id only
  // means anything inside one mailbox, so this grouping is what makes the
  // provider lookup possible at all.
  const mailboxes: Mailbox[] = [];
  for (const { id: tenantId } of tenants) {
    const rows = await withTenantContext(
      prisma,
      tenantId,
      (tx) =>
        tx.$queryRaw<
          {
            connectorAccountId: string;
            custodianId: string;
            externalId: string;
            email: string;
            folder: string;
            emails: bigint;
          }[]
        >`
        SELECT c."connectorAccountId", c.id AS "custodianId", c."externalId", c.email,
               em.folder, count(*) AS emails
          FROM email_metadata em
          JOIN evidence_items ei ON ei.id = em."evidenceItemId"
          JOIN custodians c ON c.id = ei."custodianId"
         WHERE em.folder <> '' AND em.folder NOT LIKE '%/%'
         GROUP BY 1,2,3,4,5
      `,
    );
    const byMailbox = new Map<string, Mailbox>();
    for (const r of rows) {
      const key = `${r.connectorAccountId}:${r.custodianId}`;
      const m = byMailbox.get(key) ?? {
        tenantId,
        connectorAccountId: r.connectorAccountId,
        custodianId: r.custodianId,
        externalId: r.externalId,
        email: r.email,
        folderIds: [],
        emails: 0,
      };
      m.folderIds.push(r.folder);
      m.emails += Number(r.emails);
      byMailbox.set(key, m);
    }
    mailboxes.push(...byMailbox.values());
  }

  if (mailboxes.length === 0) {
    console.log('No emails carry an opaque folder id. Nothing to do.');
    await shutdown();
    return;
  }

  let totalResolved = 0;
  let totalUnresolved = 0;

  for (const mb of mailboxes) {
    console.log(
      `${mb.email}  ${String(mb.folderIds.length)} folder id(s), ${String(mb.emails)} emails`,
    );

    let names: Map<string, { path: string; wellKnown?: string }>;
    try {
      const bundle = await buildConnectorsForAccount(ctx, {
        tenantId: mb.tenantId,
        connectorAccountId: mb.connectorAccountId,
        custodian: { externalId: mb.externalId, email: mb.email },
      });
      const discovery = await requireEmail(bundle).listMailFolders(mb.externalId || mb.email);
      names = new Map(
        discovery.folders.map((f) => [f.id, { path: f.path, wellKnown: f.wellKnown }]),
      );
      for (const e of discovery.exceptions) {
        console.log(`  ! provider reported: ${e.kind} ${e.message}`);
      }
    } catch (error) {
      // The expected failure when the connector has not been reconnected.
      console.log(
        `  CANNOT REACH PROVIDER: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log("  Reconnect this mailbox's connector, then run again.\n");
      totalUnresolved += mb.folderIds.length;
      continue;
    }

    for (const id of mb.folderIds.sort()) {
      const hit = names.get(id);
      if (hit === undefined) {
        console.log(
          `  UNRESOLVED  ${id.slice(0, 28)}...  (folder deleted, or a different mailbox)`,
        );
        totalUnresolved += 1;
        continue;
      }
      const to = hit.path;
      console.log(
        `  ${id.slice(0, 22)}...  ->  ${to}${hit.wellKnown ? `  [${hit.wellKnown}]` : ''}`,
      );
      totalResolved += 1;

      if (!commit) continue;

      const updated = await withTenantContext(prisma, mb.tenantId, (tx) =>
        tx.emailMetadata.updateMany({ where: { folder: id }, data: { folder: to } }),
      );
      // Engine-side, not a re-index: one field across a whole mailbox.
      const search = await ctx.search.setEmailFolder(mb.tenantId, id, to);
      console.log(
        `      db rows ${String(updated.count)}, search updated ${String(search.updated)}, ` +
          `unchanged ${String(search.unchanged)}, conflicts ${String(search.conflicts)}`,
      );
    }
    console.log('');
  }

  console.log(`resolved ${String(totalResolved)}, unresolved ${String(totalUnresolved)}`);
  if (!commit) console.log('Nothing written. Re-run with --commit.');

  await shutdown();
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
