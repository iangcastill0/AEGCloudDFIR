#!/usr/bin/env tsx
/**
 * Rebuild the OpenSearch index from PostgreSQL/S3 truth (ADR-006).
 *
 *   pnpm tsx scripts/reindex.ts                 # all tenants, new version + alias swap
 *   pnpm tsx scripts/reindex.ts -- --tenant <uuid>
 *
 * The index is disposable; this streams evidence metadata (plus stored text
 * derivatives) into a fresh versioned index and atomically swaps the alias.
 */
import { loadConfig } from '@evidencevault/config';
import { createPrismaClient, withTenantContext } from '@evidencevault/database';
import { OpenSearchAdapter, type EvidenceSearchDoc } from '@evidencevault/search';

const BATCH = 200;

async function* loadDocs(
  prisma: ReturnType<typeof createPrismaClient>,
  tenantIds: string[],
): AsyncIterable<EvidenceSearchDoc[]> {
  for (const tenantId of tenantIds) {
    let cursor: string | undefined;
    for (;;) {
      const page = await withTenantContext(prisma, tenantId, (tx) =>
        tx.evidenceItem.findMany({
          take: BATCH,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
          include: {
            emailMetadata: true,
            driveMetadata: true,
            participants: true,
            headers: { orderBy: { position: 'asc' }, take: 200 },
            ocrPages: { orderBy: { pageNumber: 'asc' }, take: 500 },
            tagAssignments: { include: { tag: true } },
            caseItems: true,
            custodian: true,
            productionItems: { include: { productionRun: { include: { production: true } } } },
            childRelationships: true,
          },
        }),
      );
      if (page.length === 0) break;
      yield page.map((item): EvidenceSearchDoc => {
        const em = item.emailMetadata;
        const participantsBy = (role: string) =>
          item.participants
            .filter((p) => p.role === role)
            .map((p) => ({ name: p.rawName, address: p.normalizedAddress, domain: p.domain }));
        return {
          evidenceItemId: item.id,
          tenantId: item.tenantId,
          kind: item.kind === 'email' ? 'email' : item.kind === 'attachment' ? 'attachment' : 'file',
          name: item.name,
          extension: item.extension,
          mimeType: item.mimeType,
          size: Number(item.size),
          sha256: item.sha256,
          custodianId: item.custodianId ?? undefined,
          custodianEmail: item.custodian?.email,
          provider: item.provider ?? undefined,
          collectionId: item.collectionId ?? undefined,
          sourcePath: item.sourcePath,
          sourceLabels: item.sourceLabels,
          folder: em?.folder ?? '',
          dates: {
            sent: em?.sentAt?.toISOString(),
            received: em?.receivedAt?.toISOString(),
            created: item.sourceCreatedAt?.toISOString(),
            modified: item.sourceModifiedAt?.toISOString(),
            acquired: item.acquiredAt.toISOString(),
            primary: item.primaryDate?.toISOString(),
          },
          email: em
            ? {
                subject: em.subject,
                messageId: em.messageId,
                inReplyTo: em.inReplyTo,
                references: em.references,
                threadId: em.threadId || em.conversationId,
                from: participantsBy('from'),
                sender: participantsBy('sender'),
                to: participantsBy('to'),
                cc: participantsBy('cc'),
                bcc: em.bccPresent ? participantsBy('bcc') : [],
                replyTo: participantsBy('reply_to'),
                bccPresent: em.bccPresent,
              }
            : undefined,
          headers: item.headers.map((h) => ({ name: h.name, value: h.value })),
          addresses: {
            all: [...new Set(item.participants.map((p) => p.normalizedAddress).filter(Boolean))],
            domains: [...new Set(item.participants.map((p) => p.domain).filter(Boolean))],
          },
          text: { body: em?.bodyPlain ?? '', bodyHtml: em?.bodyHtmlToText ?? '' },
          ocrPages: item.ocrPages.map((p) => ({
            page: p.pageNumber,
            text: p.text,
            confidence: p.confidence,
          })),
          tags: item.tagAssignments.map((a) => ({
            id: a.tag.id,
            name: a.tag.name,
            privileged: a.tag.isPrivileged,
            confidential: a.tag.isConfidential,
          })),
          tagNames: item.tagAssignments.map((a) => a.tag.name),
          caseIds: item.caseItems.map((c) => c.caseId),
          privileged: item.tagAssignments.some((a) => a.tag.isPrivileged),
          confidential: item.tagAssignments.some((a) => a.tag.isConfidential),
          processingStatus: item.processingStatus,
          malwareStatus: item.malwareStatus,
          familyId: item.childRelationships.find((r) => r.kind === 'family')?.parentId,
          isFamilyChild: item.childRelationships.length > 0,
          bates: item.productionItems.map((pi) => ({
            productionId: pi.productionRun.production.id,
            productionName: pi.productionRun.production.name,
            begBates: pi.begBates,
            endBates: pi.endBates,
          })),
          hasBeenProduced: item.productionItems.length > 0,
          indexedAt: new Date().toISOString(),
          docVersion: item.version,
        };
      });
      const last = page[page.length - 1];
      if (!last || page.length < BATCH) break;
      cursor = last.id;
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrismaClient(config.EV_DATABASE_URL);
  const adapter = new OpenSearchAdapter({
    node: config.EV_OPENSEARCH_URL,
    username: config.EV_OPENSEARCH_USERNAME,
    password: config.EV_OPENSEARCH_PASSWORD,
    indexPrefix: config.EV_OPENSEARCH_INDEX_PREFIX,
  });

  const tenantArgIdx = process.argv.indexOf('--tenant');
  const onlyTenant = tenantArgIdx >= 0 ? process.argv[tenantArgIdx + 1] : undefined;

  try {
    const tenants = onlyTenant
      ? [onlyTenant]
      : (
          await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
            return tx.tenant.findMany({ select: { id: true } });
          })
        ).map((t) => t.id);

    console.log(`reindexing ${tenants.length} tenant(s) into a new index version...`);
    const result = await adapter.reindexToNewVersion(loadDocs(prisma, tenants));
    console.log(`done: ${result.count} documents in ${result.indexName}; alias swapped`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('reindex failed (alias NOT swapped):', err instanceof Error ? err.message : err);
  process.exit(1);
});
