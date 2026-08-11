import { withTenantContext } from '@evidencevault/database';
import {
  MAPPING_VERSION,
  type BatesRecord,
  type EmailAddress,
  type EvidenceSearchDoc,
  type EvidenceTag,
  type OcrPage as SearchOcrPage,
  type RawHeader,
} from '@evidencevault/search';
import { sanitizeError, type WorkerContext } from '../context.js';
import { incrementProgress } from '../progress.js';
import { QUEUES } from '../queues.js';
import { readAllCapped } from '../streams.js';
import type { EvidenceStagePayload } from './payloads.js';

export const MAX_HEADERS_INDEXED = 200;
export const MAX_OCR_PAGES_INDEXED = 500;
const MAX_TEXT_TOTAL_BYTES = 1024 * 1024;

interface ParticipantInput {
  role: string;
  rawName: string;
  rawAddress: string;
  normalizedAddress: string;
  domain: string;
}

export interface SearchDocInput {
  evidenceItemId: string;
  tenantId: string;
  kind: string;
  name: string;
  extension: string;
  mimeType: string;
  size: number;
  sha256: string;
  custodianId: string | null;
  custodianEmail: string | null;
  provider: string | null;
  connectorAccountId?: string;
  collectionId: string | null;
  sourcePath: string;
  sourceLabels: string[];
  processingStatus: string;
  malwareStatus: string;
  primaryDate: Date | null;
  acquiredAt: Date;
  sourceCreatedAt: Date | null;
  sourceModifiedAt: Date | null;
  email: {
    subject: string;
    messageId: string;
    inReplyTo: string;
    references: string[];
    threadId: string;
    folder: string;
    bccPresent: boolean;
    sentAt: Date | null;
    receivedAt: Date | null;
  } | null;
  participants: ParticipantInput[];
  headers: { rawName: string; value: string }[];
  texts: { body?: string; bodyHtml?: string; attachment?: string; file?: string; ocr?: string };
  ocrPages: { pageNumber: number; text: string; confidence: number }[];
  tags: { id: string; name: string; isPrivileged: boolean; isConfidential: boolean }[];
  caseIds: string[];
  bates: { productionId: string; productionName: string; begBates: string; endBates: string }[];
  familyId: string | null;
  parentId: string | null;
  isFamilyChild: boolean;
}

function toEmailAddress(p: ParticipantInput): EmailAddress | null {
  if (p.normalizedAddress === '') return null;
  return {
    address: p.normalizedAddress,
    domain: p.domain,
    ...(p.rawName !== '' ? { name: p.rawName } : {}),
  };
}

function addressesFor(participants: ParticipantInput[], role: string): EmailAddress[] | undefined {
  const list = participants
    .filter((p) => p.role === role)
    .map(toEmailAddress)
    .filter((a): a is EmailAddress => a !== null);
  return list.length > 0 ? list : undefined;
}

/** Pure document assembly — the unit-testable core of search indexing. */
export function buildSearchDoc(input: SearchDocInput): EvidenceSearchDoc {
  const kind = input.kind === 'email' || input.kind === 'attachment' ? input.kind : 'file';

  const headers: RawHeader[] = input.headers
    .slice(0, MAX_HEADERS_INDEXED)
    .map((h) => ({ name: h.rawName, value: h.value }));

  const allAddresses = input.participants.map((p) => p.normalizedAddress).filter((a) => a !== '');
  const allDomains = input.participants.map((p) => p.domain).filter((d) => d !== '');

  const tags: EvidenceTag[] = input.tags.map((t) => ({
    id: t.id,
    name: t.name,
    privileged: t.isPrivileged,
    confidential: t.isConfidential,
  }));

  const bates: BatesRecord[] = input.bates.filter((b) => b.begBates !== '');

  const ocrPages: SearchOcrPage[] = input.ocrPages
    .slice(0, MAX_OCR_PAGES_INDEXED)
    .map((p) => ({ page: p.pageNumber, text: p.text, confidence: p.confidence }));

  const doc: EvidenceSearchDoc = {
    evidenceItemId: input.evidenceItemId,
    tenantId: input.tenantId,
    kind,
    name: input.name,
    extension: input.extension || undefined,
    mimeType: input.mimeType || undefined,
    size: input.size,
    sha256: input.sha256 || undefined,
    custodianId: input.custodianId ?? undefined,
    custodianEmail: input.custodianEmail ?? undefined,
    provider: input.provider ?? undefined,
    collectionId: input.collectionId ?? undefined,
    sourcePath: input.sourcePath || undefined,
    sourceLabels: input.sourceLabels.length > 0 ? input.sourceLabels : undefined,
    folder:
      input.email?.folder !== undefined && input.email.folder !== ''
        ? input.email.folder
        : undefined,
    dates: {
      sent: input.email?.sentAt?.toISOString(),
      received: input.email?.receivedAt?.toISOString(),
      created: input.sourceCreatedAt?.toISOString(),
      modified: input.sourceModifiedAt?.toISOString(),
      acquired: input.acquiredAt.toISOString(),
      primary: input.primaryDate?.toISOString() ?? input.acquiredAt.toISOString(),
    },
    headers: headers.length > 0 ? headers : undefined,
    addresses:
      allAddresses.length > 0
        ? { all: [...new Set(allAddresses)], domains: [...new Set(allDomains)] }
        : undefined,
    text: Object.values(input.texts).some((v) => v !== undefined && v !== '')
      ? input.texts
      : undefined,
    ocrPages: ocrPages.length > 0 ? ocrPages : undefined,
    tags: tags.length > 0 ? tags : undefined,
    tagNames: tags.length > 0 ? tags.map((t) => t.name) : undefined,
    caseIds: input.caseIds.length > 0 ? input.caseIds : undefined,
    privileged: tags.some((t) => t.privileged),
    confidential: tags.some((t) => t.confidential),
    processingStatus: input.processingStatus,
    malwareStatus: input.malwareStatus,
    familyId: input.familyId ?? undefined,
    parentId: input.parentId ?? undefined,
    isFamilyChild: input.isFamilyChild,
    bates: bates.length > 0 ? bates : undefined,
    hasBeenProduced: bates.length > 0,
    indexedAt: new Date().toISOString(),
    docVersion: MAPPING_VERSION,
  };

  if (input.email !== null) {
    doc.email = {
      subject: input.email.subject || undefined,
      messageId: input.email.messageId || undefined,
      inReplyTo: input.email.inReplyTo || undefined,
      references: input.email.references.length > 0 ? input.email.references : undefined,
      threadId: input.email.threadId || undefined,
      from: addressesFor(input.participants, 'from'),
      sender: addressesFor(input.participants, 'sender'),
      to: addressesFor(input.participants, 'to'),
      cc: addressesFor(input.participants, 'cc'),
      // BCC is indexed ONLY when the source genuinely carried BCC data.
      bcc: input.email.bccPresent ? addressesFor(input.participants, 'bcc') : undefined,
      replyTo: addressesFor(input.participants, 'reply_to'),
      bccPresent: input.email.bccPresent,
    };
  }

  return doc;
}

const FAMILY_KINDS = new Set(['attachment', 'inline_attachment']);

/**
 * search.index: assemble the full EvidenceSearchDoc (metadata + derivative
 * text streams) and index it. Indexing failures are routed to the dead-letter
 * outbox instead of throwing forever against a poisoned document.
 */
export async function processSearchIndex(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
): Promise<void> {
  const { tenantId, evidenceItemId } = payload;

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: {
        custodian: { select: { email: true } },
        emailMetadata: true,
        participants: { orderBy: { position: 'asc' } },
        headers: { orderBy: { position: 'asc' }, take: MAX_HEADERS_INDEXED },
        extractedTexts: true,
        ocrPages: { orderBy: { pageNumber: 'asc' }, take: MAX_OCR_PAGES_INDEXED },
        tagAssignments: { include: { tag: true } },
        caseItems: { select: { caseId: true } },
        productionItems: {
          include: {
            productionRun: { include: { production: { select: { id: true, name: true } } } },
          },
        },
        childRelationships: true,
        parentRelationships: { select: { kind: true } },
      },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'index: evidence item not found; dropping');
    return;
  }

  // Family linkage: a child points at its parent; a parent with attachment
  // children heads its own family.
  const parentRel = item.childRelationships.find((r) => FAMILY_KINDS.has(r.kind));
  const hasChildren = item.parentRelationships.some((r) => FAMILY_KINDS.has(r.kind));
  const familyId = parentRel !== undefined ? parentRel.parentId : hasChildren ? item.id : null;

  // Load derivative text contents, bounded to 1MB total.
  const texts: SearchDocInput['texts'] = {};
  let budget = MAX_TEXT_TOTAL_BYTES;
  for (const extracted of item.extractedTexts) {
    if (budget <= 0) break;
    let content: string;
    try {
      const stream = await ctx.store.getStream('evidence', extracted.objectKey);
      content = (await readAllCapped(stream, budget)).toString('utf8');
    } catch {
      continue; // missing derivative: index the rest honestly
    }
    budget -= Buffer.byteLength(content, 'utf8');
    switch (extracted.kind) {
      case 'body_plain':
        texts.body = content;
        break;
      case 'body_html_to_text':
        texts.bodyHtml = content;
        break;
      case 'file_text':
        if (item.kind === 'attachment') texts.attachment = content;
        else texts.file = content;
        break;
      case 'ocr_text':
        texts.ocr = content;
        break;
      default:
        break;
    }
  }

  const doc = buildSearchDoc({
    evidenceItemId: item.id,
    tenantId,
    kind: item.kind,
    name: item.name,
    extension: item.extension,
    mimeType: item.mimeType,
    size: Number(item.size),
    sha256: item.sha256,
    custodianId: item.custodianId,
    custodianEmail: item.custodian?.email ?? null,
    provider: item.provider,
    collectionId: item.collectionId,
    sourcePath: item.sourcePath,
    sourceLabels: item.sourceLabels,
    processingStatus: item.processingStatus,
    malwareStatus: item.malwareStatus,
    primaryDate: item.primaryDate,
    acquiredAt: item.acquiredAt,
    sourceCreatedAt: item.sourceCreatedAt,
    sourceModifiedAt: item.sourceModifiedAt,
    email:
      item.emailMetadata !== null
        ? {
            subject: item.emailMetadata.subject,
            messageId: item.emailMetadata.messageId,
            inReplyTo: item.emailMetadata.inReplyTo,
            references: item.emailMetadata.references,
            threadId: item.emailMetadata.threadId,
            folder: item.emailMetadata.folder,
            bccPresent: item.emailMetadata.bccPresent,
            sentAt: item.emailMetadata.sentAt,
            receivedAt: item.emailMetadata.receivedAt,
          }
        : null,
    participants: item.participants,
    headers: item.headers,
    texts,
    ocrPages: item.ocrPages,
    tags: item.tagAssignments.map((a) => a.tag),
    caseIds: [...new Set(item.caseItems.map((c) => c.caseId))],
    bates: item.productionItems.map((p) => ({
      productionId: p.productionRun.production.id,
      productionName: p.productionRun.production.name,
      begBates: p.begBates,
      endBates: p.endBates,
    })),
    familyId,
    parentId: parentRel?.parentId ?? null,
    isFamilyChild: parentRel !== undefined,
  });

  const result = await ctx.search.indexBulk([doc]);
  if (result.errors.length > 0) {
    const error = result.errors[0]?.error ?? 'unknown indexing error';
    ctx.log.error({ evidenceItemId, error }, 'index: document rejected by search engine');
    await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: QUEUES.deadLetter,
            dedupKey: `dead:index:${evidenceItemId}:v${payload.version}`,
            payload: {
              tenantId,
              reason: 'search-index-error',
              evidenceItemId,
              error: sanitizeError(new Error(error)),
            },
          },
        ],
        skipDuplicates: true,
      }),
    );
    return;
  }

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.evidenceItem.updateMany({
      where: {
        id: evidenceItemId,
        processingStatus: { in: ['parsed', 'extracted', 'ocr_complete', 'preview_ready'] },
      },
      data: { processingStatus: 'indexed' },
    });
    const updated = await tx.collectionItem.updateMany({
      where: { evidenceItemId, state: 'preserved' },
      data: { state: 'indexed' },
    });
    if (updated.count > 0 && item.collectionId !== null && item.custodianId !== null) {
      await incrementProgress(
        tx,
        item.collectionId,
        item.custodianId,
        item.kind === 'email' ? 'email' : 'drive',
        { indexed: updated.count },
      );
    }
  });
}
