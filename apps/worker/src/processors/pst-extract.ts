import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendAuditEvent, withTenantContext, type TenantScopedTx } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { buildEml, type EmlAddress } from './pst-mime.js';
import {
  isPstEncryptionError,
  realPstReader,
  type PstArchive,
  type PstMessageData,
  type PstReader,
} from './pst-reader.js';
import type { PstExtractPayload } from './payloads.js';

/**
 * pst.extract: reconstruct the messages of one preserved uploaded container.
 *
 * FORENSIC HONESTY: the uploaded PST/OST is already preserved byte-for-byte
 * as the immutable content-addressed original (kind 'container'). Every
 * message written here is a RECONSTRUCTION synthesized from the container's
 * stored properties (true transport headers used when retained), carries
 * processingDetail 'extracted-from-pst' and a container_member relationship
 * back to the container, and is never presented as provider-native RFC 822.
 * Encrypted or corrupt containers become CollectionExceptions — never
 * brute-forced.
 */

export interface PstExtractDeps {
  reader?: PstReader;
}

/** Sentinel used to stop the folder walk at the message cap. */
class MessageCapReached extends Error {
  constructor() {
    super('message cap reached');
    this.name = 'MessageCapReached';
  }
}

const TERMINAL_ITEM_STATES = new Set(['preserved', 'processed', 'indexed']);

function containerMemberId(containerId: string, descriptorNodeId: string): string {
  return `pst:${containerId}:${descriptorNodeId}`;
}

function toAddresses(
  recipients: PstMessageData['recipients'],
  kind: 'to' | 'cc' | 'bcc',
  displayFallback: string,
): EmlAddress[] {
  const matched = recipients
    .filter((r) => r.kind === kind)
    .map((r) => ({ name: r.name, address: r.address }));
  if (matched.length > 0) return matched;
  // The PST kept only a display string (no addresses): carry it as a
  // name-only mailbox rather than inventing an address.
  if (displayFallback !== '') return [{ name: displayFallback, address: '' }];
  return [];
}

function synthesizeEml(msg: PstMessageData): Buffer {
  const hasTransportHeaders = msg.transportMessageHeaders.trim() !== '';
  const bcc = toAddresses(msg.recipients, 'bcc', msg.displayBcc);
  return buildEml({
    ...(hasTransportHeaders ? { headersRaw: msg.transportMessageHeaders } : {}),
    from: { name: msg.senderName, address: msg.senderEmailAddress },
    to: toAddresses(msg.recipients, 'to', msg.displayTo),
    cc: toAddresses(msg.recipients, 'cc', msg.displayCc),
    bcc,
    subject: msg.subject,
    ...(msg.clientSubmitTime !== null
      ? { date: msg.clientSubmitTime }
      : msg.messageDeliveryTime !== null
        ? { date: msg.messageDeliveryTime }
        : {}),
    ...(msg.internetMessageId !== '' ? { messageId: msg.internetMessageId } : {}),
    bodyPlain: msg.bodyPlain,
    bodyHtml: msg.bodyHtml,
    attachments: msg.attachments,
  });
}

/** True when the PST retained BCC data for this message. */
function bccPresent(msg: PstMessageData): boolean {
  return msg.recipients.some((r) => r.kind === 'bcc') || msg.displayBcc !== '';
}

export async function processPstExtract(
  ctx: WorkerContext,
  payload: PstExtractPayload,
  deps: PstExtractDeps = {},
): Promise<void> {
  const { tenantId, collectionId, custodianId, evidenceItemId } = payload;
  const reader = deps.reader ?? realPstReader;
  const containerProviderItemId = `pst:${evidenceItemId}`;

  const loaded = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const container = await tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: { blob: true },
    });
    const collection = await tx.collection.findUnique({
      where: { id: collectionId },
      select: { status: true },
    });
    const containerItem = await tx.collectionItem.findUnique({
      where: {
        collectionId_custodianId_source_providerItemId: {
          collectionId,
          custodianId,
          source: 'email',
          providerItemId: containerProviderItemId,
        },
      },
      select: { id: true, state: true },
    });
    const childCount = await tx.evidenceRelationship.count({
      where: { parentId: evidenceItemId, kind: 'container_member' },
    });
    const existingMembers = await tx.collectionItem.findMany({
      where: {
        collectionId,
        custodianId,
        source: 'email',
        providerItemId: { startsWith: `pst:${evidenceItemId}:` },
      },
      select: { providerItemId: true, state: true },
    });
    return { container, collection, containerItem, childCount, existingMembers };
  });

  if (loaded.container === null || loaded.container.blob === null) {
    ctx.log.warn({ evidenceItemId }, 'pst-extract: container or blob missing; dropping');
    return;
  }
  if (loaded.container.kind !== 'container') {
    ctx.log.warn({ evidenceItemId }, 'pst-extract: evidence item is not a container; dropping');
    return;
  }
  if (loaded.collection === null || loaded.collection.status !== 'fetching') {
    ctx.log.info(
      { collectionId, status: loaded.collection?.status },
      'pst-extract: collection not in fetching state; dropping',
    );
    return;
  }
  // Idempotent early return: extraction already completed for this container.
  if (loaded.childCount > 0 && loaded.containerItem?.state === 'processed') return;

  const container = loaded.container;
  const containerBlob = container.blob;
  if (containerBlob === null) return;
  const alreadyPreserved = new Set(
    loaded.existingMembers
      .filter((m) => TERMINAL_ITEM_STATES.has(m.state))
      .map((m) => m.providerItemId),
  );

  const tempDir = await mkdtemp(join(tmpdir(), 'cdfir-pst-'));
  const tempFile = join(tempDir, 'container.pst');
  let archive: PstArchive | null = null;
  const maxMessages = ctx.config.CDFIR_PST_MAX_MESSAGES;
  let extracted = 0;
  let capExceeded = false;
  let messageFailures = 0;

  try {
    // Never buffer the container: stream it from the store to a temp file.
    const blobStream = await ctx.store.getStream(
      containerBlob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
      containerBlob.objectKey,
    );
    await pipeline(blobStream, createWriteStream(tempFile));

    try {
      archive = reader.open(tempFile);
    } catch (err) {
      const message = sanitizeError(err);
      if (isPstEncryptionError(err)) {
        // Password-protected / encrypted container: recorded, never brute-forced.
        await withTenantContext(ctx.prisma, tenantId, async (tx) => {
          await recordException(tx, {
            tenantId,
            collectionId,
            custodianId,
            source: 'email',
            providerItemId: containerProviderItemId,
            kind: 'encrypted_item',
            message: `container is encrypted or password-protected and was not extracted: ${message}`,
          });
          await tx.collectionItem.updateMany({
            where: { collectionId, custodianId, providerItemId: containerProviderItemId },
            data: { state: 'skipped', lastError: message },
          });
          await tx.evidenceItem.update({
            where: { id: evidenceItemId },
            data: { processingStatus: 'exception', processingDetail: 'encrypted-container' },
          });
          await incrementProgress(tx, collectionId, custodianId, 'email', { warnings: 1 });
          await enqueueFinalize(tx, tenantId, collectionId, evidenceItemId);
        });
        return;
      }
      // Unreadable container: permanent failure, no rethrow (retry cannot help).
      await withTenantContext(ctx.prisma, tenantId, async (tx) => {
        await recordException(tx, {
          tenantId,
          collectionId,
          custodianId,
          source: 'email',
          providerItemId: containerProviderItemId,
          kind: 'corrupt_item',
          message: `container could not be parsed: ${message}`,
        });
        await tx.collectionItem.updateMany({
          where: { collectionId, custodianId, providerItemId: containerProviderItemId },
          data: { state: 'failed', lastError: message },
        });
        await tx.evidenceItem.update({
          where: { id: evidenceItemId },
          data: { processingStatus: 'exception', processingDetail: 'corrupt-container' },
        });
        await incrementProgress(tx, collectionId, custodianId, 'email', { failures: 1 });
        await enqueueFinalize(tx, tenantId, collectionId, evidenceItemId);
      });
      return;
    }

    const openArchive = archive;
    try {
      await openArchive.walk(async (msg, folderPath) => {
        if (extracted >= maxMessages) {
          capExceeded = true;
          throw new MessageCapReached();
        }
        const providerItemId = containerMemberId(evidenceItemId, msg.descriptorNodeId);
        if (alreadyPreserved.has(providerItemId)) return; // resumed run
        try {
          await preserveMessage(ctx, {
            tenantId,
            collectionId,
            custodianId,
            containerId: evidenceItemId,
            containerName: container.name,
            containerSha256: container.sha256,
            providerItemId,
            folderPath,
            msg,
          });
          extracted += 1;
        } catch (err) {
          messageFailures += 1;
          const message = sanitizeError(err);
          ctx.log.warn(
            { collectionId, providerItemId, err: message },
            'pst-extract: message reconstruction failed',
          );
          await withTenantContext(ctx.prisma, tenantId, async (tx) => {
            await recordException(tx, {
              tenantId,
              collectionId,
              custodianId,
              source: 'email',
              providerItemId,
              kind: 'corrupt_item',
              message: `message could not be reconstructed from the container: ${message}`,
              detail: { folderPath },
            });
            await incrementProgress(tx, collectionId, custodianId, 'email', { failures: 1 });
          });
        }
      });
    } catch (err) {
      if (!(err instanceof MessageCapReached)) {
        // Structural failure mid-walk: keep what was extracted, record the rest.
        const message = sanitizeError(err);
        await withTenantContext(ctx.prisma, tenantId, async (tx) => {
          await recordException(tx, {
            tenantId,
            collectionId,
            custodianId,
            source: 'email',
            providerItemId: containerProviderItemId,
            kind: 'corrupt_item',
            message: `container walk failed after ${extracted} message(s): ${message}`,
          });
          await tx.collectionItem.updateMany({
            where: { collectionId, custodianId, providerItemId: containerProviderItemId },
            data: { state: 'failed', lastError: message },
          });
          await tx.evidenceItem.update({
            where: { id: evidenceItemId },
            data: { processingStatus: 'exception', processingDetail: 'corrupt-container' },
          });
          await incrementProgress(tx, collectionId, custodianId, 'email', { failures: 1 });
          await enqueueFinalize(tx, tenantId, collectionId, evidenceItemId);
        });
        return;
      }
      await withTenantContext(ctx.prisma, tenantId, (tx) =>
        recordException(tx, {
          tenantId,
          collectionId,
          custodianId,
          source: 'email',
          providerItemId: containerProviderItemId,
          kind: 'unsupported_item',
          message:
            `container holds more than the configured limit of ${maxMessages} messages; ` +
            `extraction stopped at the limit and the remainder was NOT extracted ` +
            `(the preserved container still holds every message)`,
        }),
      );
    }

    // Close out the container: reconstruction finished (possibly with
    // per-message exceptions, which are recorded above).
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.collectionItem.updateMany({
        where: { collectionId, custodianId, providerItemId: containerProviderItemId },
        data: { state: 'processed', lastError: '' },
      });
      await tx.evidenceItem.update({
        where: { id: evidenceItemId },
        data: { processingStatus: 'extracted' },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'evidence.container_extraction_completed',
        targetType: 'evidence_item',
        targetId: evidenceItemId,
        actorDisplay: 'worker',
        summary: {
          collectionId,
          messagesExtracted: extracted,
          messageFailures,
          capExceeded,
          containerSha256: container.sha256,
        },
      });
      await tx.outboxEvent.createMany({
        data: [
          {
            // Index the container itself so the uploaded file is findable.
            tenantId,
            topic: QUEUES.searchIndex,
            dedupKey: dedupKeys.searchIndex(evidenceItemId, 1, 'pst-container'),
            payload: { tenantId, evidenceItemId, version: 1 },
          },
        ],
        skipDuplicates: true,
      });
      await enqueueFinalize(tx, tenantId, collectionId, evidenceItemId);
    });
  } finally {
    try {
      archive?.close();
    } catch {
      // best-effort close; the temp dir removal below is what matters
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface PreserveMessageInput {
  tenantId: string;
  collectionId: string;
  custodianId: string;
  containerId: string;
  containerName: string;
  containerSha256: string;
  providerItemId: string;
  folderPath: string;
  msg: PstMessageData;
}

async function preserveMessage(ctx: WorkerContext, input: PreserveMessageInput): Promise<void> {
  const { tenantId, collectionId, custodianId, providerItemId, folderPath, msg } = input;

  const eml = synthesizeEml(msg);
  const staged = await ctx.store.stageStream(tenantId, Readable.from([eml]));
  const promoted = await ctx.store.promoteToOriginal(
    tenantId,
    staged.stagingKey,
    { sha256: staged.sha256, size: staged.size },
    { quarantine: false },
  );

  const primaryDate = msg.messageDeliveryTime ?? msg.clientSubmitTime;
  const name = msg.subject !== '' ? msg.subject : '(no subject)';
  const sourcePath =
    folderPath === '' ? input.containerName : `${input.containerName}/${folderPath}`;

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.evidenceBlob.createMany({
      data: [
        {
          tenantId,
          sha256: staged.sha256,
          size: BigInt(staged.size),
          objectKey: promoted.objectKey,
        },
      ],
      skipDuplicates: true,
    });
    const blob = await tx.evidenceBlob.findUniqueOrThrow({
      where: { tenantId_sha256: { tenantId, sha256: staged.sha256 } },
      select: { id: true },
    });

    const evidence = await tx.evidenceItem.create({
      data: {
        tenantId,
        custodianId,
        collectionId,
        blobId: blob.id,
        kind: 'email',
        name: name.slice(0, 500),
        extension: 'eml',
        mimeType: 'message/rfc822',
        size: BigInt(staged.size),
        sha256: staged.sha256,
        provider: 'upload',
        providerItemId,
        sourcePath: sourcePath.slice(0, 1000),
        // The .eml is synthesized from container properties, never
        // provider-native: labeled for UI, exports, and manifests.
        processingDetail: 'extracted-from-pst',
        primaryDate,
        acquiredAt: new Date(),
      },
      select: { id: true },
    });

    await tx.emailMetadata.create({
      data: {
        tenantId,
        evidenceItemId: evidence.id,
        subject: msg.subject,
        messageId: msg.internetMessageId,
        sentAt: msg.clientSubmitTime,
        receivedAt: msg.messageDeliveryTime,
        folder: folderPath,
        // BCC is recorded ONLY when the container actually stored it.
        bccPresent: bccPresent(msg),
        hasAttachments: msg.attachments.length > 0 || msg.oversizedAttachments.length > 0,
      },
    });

    await tx.evidenceRelationship.create({
      data: {
        tenantId,
        parentId: input.containerId,
        childId: evidence.id,
        kind: 'container_member',
        detail: folderPath,
      },
    });

    await tx.collectionItem.upsert({
      where: {
        collectionId_custodianId_source_providerItemId: {
          collectionId,
          custodianId,
          source: 'email',
          providerItemId,
        },
      },
      create: {
        tenantId,
        collectionId,
        custodianId,
        source: 'email',
        providerItemId,
        state: 'preserved',
        evidenceItemId: evidence.id,
      },
      update: { state: 'preserved', evidenceItemId: evidence.id, lastError: '' },
    });

    for (const filename of msg.oversizedAttachments) {
      await recordException(tx, {
        tenantId,
        collectionId,
        custodianId,
        source: 'email',
        providerItemId,
        kind: 'unsupported_item',
        message: `attachment '${filename}' exceeds the per-attachment reconstruction cap and was omitted from the synthesized message (it remains inside the preserved container)`,
        detail: { folderPath },
      });
    }

    await incrementProgress(tx, collectionId, custodianId, 'email', {
      discovered: 1,
      fetched: 1,
      preserved: 1,
      ...(msg.oversizedAttachments.length > 0 ? { warnings: msg.oversizedAttachments.length } : {}),
    });

    await appendAuditEvent(tx, {
      tenantId,
      action: 'evidence.extracted_from_container',
      targetType: 'evidence_item',
      targetId: evidence.id,
      actorDisplay: 'worker',
      summary: {
        containerSha256: input.containerSha256,
        folderPath,
        sha256: staged.sha256,
        size: staged.size,
        collectionId,
        reconstruction: true,
      },
    });

    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          topic: QUEUES.processParse,
          dedupKey: dedupKeys.processStage('parse', evidence.id, 1),
          payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
        },
        {
          tenantId,
          topic: QUEUES.processScan,
          dedupKey: dedupKeys.processStage('scan', evidence.id, 1),
          payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
        },
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(evidence.id, 1, 'pst-extract'),
          payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
        },
      ],
      skipDuplicates: true,
    });
  });
}

/** Nudge finalize once this container's extraction reached a terminal state. */
async function enqueueFinalize(
  tx: TenantScopedTx,
  tenantId: string,
  collectionId: string,
  evidenceItemId: string,
): Promise<void> {
  await tx.outboxEvent.createMany({
    data: [
      {
        tenantId,
        topic: QUEUES.collectionFinalize,
        dedupKey: `${dedupKeys.collectionFinalize(collectionId)}:chk:pst:${evidenceItemId}`,
        payload: { tenantId, collectionId },
      },
    ],
    skipDuplicates: true,
  });
}
