import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { appendAuditEvent, withTenantContext, type Prisma } from '@evidencevault/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { PayloadTooLargeError, readAllCapped } from '../streams.js';
import {
  loadEmailParser,
  type EmailParser,
  type ParsedAddress,
  type ParsedEmail,
} from './parse-adapter.js';
import type { EvidenceStagePayload } from './payloads.js';

const MAX_EMAIL_BYTES = 200 * 1024 * 1024;
const MAX_BODY_CHARS = 1024 * 1024;
/** Statuses at/after 'parsed': the idempotent early-return set. */
const DONE_STATUSES = new Set(['parsed', 'extracted', 'ocr_complete', 'preview_ready', 'indexed']);

export interface ParseDeps {
  loadParser?: () => Promise<EmailParser>;
}

type ParticipantRole = 'from' | 'sender' | 'to' | 'cc' | 'bcc' | 'reply_to';

function participantRows(
  tenantId: string,
  evidenceItemId: string,
  role: ParticipantRole,
  addresses: ParsedAddress[],
): Prisma.EmailParticipantCreateManyInput[] {
  return addresses.map((addr, position) => {
    const raw = addr.address ?? '';
    const normalized = raw.trim().toLowerCase();
    const at = normalized.lastIndexOf('@');
    return {
      tenantId,
      evidenceItemId,
      role,
      rawName: addr.name ?? '',
      rawAddress: raw,
      normalizedAddress: normalized,
      domain: at > 0 ? normalized.slice(at + 1) : '',
      position,
    };
  });
}

interface StagedAttachment {
  id: string;
  filename: string;
  contentType: string;
  contentId?: string;
  isInline: boolean;
  sha256: string;
  size: number;
  objectKey: string;
}

/**
 * process.parse: parse an acquired email's RFC822 native into metadata,
 * headers, participants, body text, attachments (as child evidence items),
 * and a safe preview. Idempotent via the processingStatus gate; the entire
 * row bundle commits in one transaction.
 */
export async function processParse(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  deps: ParseDeps = {},
): Promise<void> {
  const { tenantId, evidenceItemId } = payload;
  const version = payload.version;

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: { blob: true, emailMetadata: true },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'parse: evidence item not found; dropping');
    return;
  }
  if (item.kind !== 'email') return;
  if (DONE_STATUSES.has(item.processingStatus)) return; // already parsed
  if (item.blob === null) return;

  let raw: Buffer;
  try {
    const stream = await ctx.store.getStream(
      item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
      item.blob.objectKey,
    );
    raw = await readAllCapped(stream, MAX_EMAIL_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      await markException(ctx, item, payload, 'unsupported_item', sanitizeError(err));
      return;
    }
    throw err;
  }

  const parser = await (deps.loadParser ?? loadEmailParser)();
  let parsed: ParsedEmail;
  try {
    parsed = await parser.parse(raw);
  } catch (err) {
    await markException(ctx, item, payload, 'corrupt_item', sanitizeError(err));
    return;
  }

  const bodyPlain = parsed.bodyPlain.slice(0, MAX_BODY_CHARS);
  const bodyHtmlToText =
    parsed.bodyHtml !== undefined
      ? parser.htmlToText(parsed.bodyHtml).slice(0, MAX_BODY_CHARS)
      : '';

  // --- Attachments: stage + promote bytes before the transaction. ---
  const stagedAttachments: StagedAttachment[] = [];
  for (const attachment of parsed.attachments) {
    const childId = randomUUID();
    const staged = await ctx.store.stageStream(
      tenantId,
      Readable.from(Buffer.from(attachment.content)),
    );
    const promoted = await ctx.store.promoteToOriginal(
      tenantId,
      staged.stagingKey,
      { sha256: staged.sha256, size: staged.size },
      { quarantine: false },
    );
    stagedAttachments.push({
      id: childId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      contentId: attachment.contentId,
      isInline: attachment.isInline === true,
      sha256: staged.sha256,
      size: staged.size,
      objectKey: promoted.objectKey,
    });
  }

  // --- Derivatives: body text and preview, uploaded before the transaction. ---
  const derivatives: {
    kind: 'body_plain' | 'body_html_to_text';
    objectKey: string;
    sha256: string;
    charCount: number;
  }[] = [];
  if (bodyPlain !== '') {
    const put = await ctx.store.putDerivative(
      tenantId,
      evidenceItemId,
      'text',
      version,
      'body.txt',
      Buffer.from(bodyPlain, 'utf8'),
      'text/plain; charset=utf-8',
    );
    derivatives.push({ kind: 'body_plain', ...put, charCount: bodyPlain.length });
  }
  if (bodyHtmlToText !== '') {
    const put = await ctx.store.putDerivative(
      tenantId,
      evidenceItemId,
      'text',
      version,
      'body-html.txt',
      Buffer.from(bodyHtmlToText, 'utf8'),
      'text/plain; charset=utf-8',
    );
    derivatives.push({ kind: 'body_html_to_text', ...put, charCount: bodyHtmlToText.length });
  }

  let preview: { kind: 'safe_html' | 'text'; objectKey: string; mimeType: string } | null = null;
  if (parsed.bodyHtml !== undefined && parser.buildSafePreview !== undefined) {
    const cidToChild = new Map(
      stagedAttachments
        .filter((a) => a.contentId !== undefined)
        .map((a) => [a.contentId as string, a.id]),
    );
    const safeHtml = parser.buildSafePreview(parsed.bodyHtml, (contentId) => {
      const childId = cidToChild.get(contentId);
      return childId !== undefined ? `/api/v1/evidence/${childId}/preview` : '';
    });
    const put = await ctx.store.putDerivative(
      tenantId,
      evidenceItemId,
      'safe_html',
      version,
      'preview.html',
      Buffer.from(safeHtml, 'utf8'),
      'text/html; charset=utf-8',
    );
    preview = { kind: 'safe_html', objectKey: put.objectKey, mimeType: 'text/html; charset=utf-8' };
  } else if (bodyPlain !== '') {
    const put = await ctx.store.putDerivative(
      tenantId,
      evidenceItemId,
      'preview-text',
      version,
      'preview.txt',
      Buffer.from(bodyPlain, 'utf8'),
      'text/plain; charset=utf-8',
    );
    preview = { kind: 'text', objectKey: put.objectKey, mimeType: 'text/plain; charset=utf-8' };
  }

  const parsedDate = parsed.date !== undefined ? new Date(parsed.date) : null;

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const metadataFields = {
      subject: parsed.subject,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      rawDateHeader: parsed.rawDateHeader,
      bodyPlain,
      bodyHtmlToText,
      isEncrypted: parsed.isEncrypted,
      smimeType: parsed.smimeType,
      hasAttachments:
        (item.emailMetadata?.hasAttachments ?? false) || parsed.attachments.length > 0,
      // bccPresent may ONLY be strengthened by an actual Bcc header.
      bccPresent: (item.emailMetadata?.bccPresent ?? false) || parsed.bcc.length > 0,
      ...(item.emailMetadata?.sentAt === null && parsedDate !== null ? { sentAt: parsedDate } : {}),
    };
    await tx.emailMetadata.upsert({
      where: { evidenceItemId },
      create: { tenantId, evidenceItemId, ...metadataFields },
      update: metadataFields,
    });

    await tx.header.deleteMany({ where: { evidenceItemId } });
    if (parsed.headers.length > 0) {
      await tx.header.createMany({
        data: parsed.headers.slice(0, 1000).map((h, position) => ({
          tenantId,
          evidenceItemId,
          name: h.name.toLowerCase(),
          rawName: h.name,
          value: h.value.slice(0, 4000),
          position,
        })),
      });
    }

    await tx.emailParticipant.deleteMany({ where: { evidenceItemId } });
    const participants = [
      ...participantRows(tenantId, evidenceItemId, 'from', parsed.from),
      ...participantRows(tenantId, evidenceItemId, 'sender', parsed.sender),
      ...participantRows(tenantId, evidenceItemId, 'to', parsed.to),
      ...participantRows(tenantId, evidenceItemId, 'cc', parsed.cc),
      ...participantRows(tenantId, evidenceItemId, 'bcc', parsed.bcc),
      ...participantRows(tenantId, evidenceItemId, 'reply_to', parsed.replyTo),
    ];
    if (participants.length > 0) {
      await tx.emailParticipant.createMany({ data: participants });
    }

    for (const derivative of derivatives) {
      await tx.extractedText.upsert({
        where: {
          evidenceItemId_kind_version: { evidenceItemId, kind: derivative.kind, version },
        },
        create: {
          tenantId,
          evidenceItemId,
          kind: derivative.kind,
          objectKey: derivative.objectKey,
          sha256: derivative.sha256,
          charCount: derivative.charCount,
          extractorName: parsed.parserName,
          extractorVersion: parsed.parserVersion,
          version,
        },
        update: { objectKey: derivative.objectKey, sha256: derivative.sha256 },
      });
    }

    if (preview !== null) {
      await tx.preview.upsert({
        where: { evidenceItemId_kind_version: { evidenceItemId, kind: preview.kind, version } },
        create: {
          tenantId,
          evidenceItemId,
          kind: preview.kind,
          objectKey: preview.objectKey,
          mimeType: preview.mimeType,
          generatorName: parsed.parserName,
          generatorVersion: parsed.parserVersion,
          version,
        },
        update: { objectKey: preview.objectKey },
      });
    }

    const childOutbox: Prisma.OutboxEventCreateManyInput[] = [];
    for (const attachment of stagedAttachments) {
      await tx.evidenceBlob.createMany({
        data: [
          {
            tenantId,
            sha256: attachment.sha256,
            size: BigInt(attachment.size),
            objectKey: attachment.objectKey,
          },
        ],
        skipDuplicates: true,
      });
      const blob = await tx.evidenceBlob.findUniqueOrThrow({
        where: { tenantId_sha256: { tenantId, sha256: attachment.sha256 } },
        select: { id: true },
      });
      await tx.evidenceItem.create({
        data: {
          id: attachment.id,
          tenantId,
          custodianId: item.custodianId,
          collectionId: item.collectionId,
          blobId: blob.id,
          kind: 'attachment',
          name: attachment.filename.slice(0, 500),
          extension: attachment.filename.includes('.')
            ? (attachment.filename.split('.').pop()?.toLowerCase().slice(0, 16) ?? '')
            : '',
          mimeType: attachment.contentType,
          size: BigInt(attachment.size),
          sha256: attachment.sha256,
          provider: item.provider,
          primaryDate: item.primaryDate,
          acquiredAt: item.acquiredAt,
        },
      });
      await tx.evidenceRelationship.create({
        data: {
          tenantId,
          parentId: evidenceItemId,
          childId: attachment.id,
          kind: attachment.isInline ? 'inline_attachment' : 'attachment',
          detail: attachment.contentId ?? '',
        },
      });
      childOutbox.push(
        {
          tenantId,
          topic: QUEUES.processExtract,
          dedupKey: dedupKeys.processStage('extract', attachment.id, 1),
          payload: { tenantId, evidenceItemId: attachment.id, version: 1 },
        },
        {
          tenantId,
          topic: QUEUES.processScan,
          dedupKey: dedupKeys.processStage('scan', attachment.id, 1),
          payload: { tenantId, evidenceItemId: attachment.id, version: 1 },
        },
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(attachment.id, 1),
          payload: { tenantId, evidenceItemId: attachment.id, version: 1 },
        },
      );
    }

    await tx.evidenceItem.update({
      where: { id: evidenceItemId },
      data: {
        processingStatus: 'parsed',
        processingDetail: parsed.parserName === 'minimal-parser' ? 'minimal-parser' : '',
      },
    });

    if (item.collectionId !== null && item.custodianId !== null) {
      await incrementProgress(tx, item.collectionId, item.custodianId, 'email', { parsed: 1 });
    }
    await appendAuditEvent(tx, {
      tenantId,
      action: 'evidence.parsed',
      targetType: 'evidence_item',
      targetId: evidenceItemId,
      actorDisplay: 'worker',
      summary: {
        parser: parsed.parserName,
        attachments: stagedAttachments.length,
        headers: parsed.headers.length,
      },
    });

    await tx.outboxEvent.createMany({
      data: [
        ...childOutbox,
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(evidenceItemId, version),
          payload: { tenantId, evidenceItemId, version },
        },
      ],
      skipDuplicates: true,
    });
  });
}

async function markException(
  ctx: WorkerContext,
  item: {
    id: string;
    collectionId: string | null;
    custodianId: string | null;
    providerItemId: string;
  },
  payload: EvidenceStagePayload,
  kind: 'unsupported_item' | 'corrupt_item',
  message: string,
): Promise<void> {
  await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
    if (item.collectionId !== null) {
      await recordException(tx, {
        tenantId: payload.tenantId,
        collectionId: item.collectionId,
        custodianId: item.custodianId ?? undefined,
        source: 'email',
        providerItemId: item.providerItemId,
        kind,
        message,
      });
    }
    await tx.evidenceItem.update({
      where: { id: item.id },
      data: { processingStatus: 'exception', processingDetail: message.slice(0, 500) },
    });
    // Still index what we know about the item (metadata-only doc).
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId: payload.tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(item.id, payload.version),
          payload: {
            tenantId: payload.tenantId,
            evidenceItemId: item.id,
            version: payload.version,
          },
        },
      ],
      skipDuplicates: true,
    });
  });
}
