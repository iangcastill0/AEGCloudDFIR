import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  GMAIL_ACCOUNT_FOLDER,
  NonDownloadableError,
  type DriveEntry,
  type EmailApiMetadata,
} from '@aeg-clouddfir/connectors';
import { appendAuditEvent, withTenantContext, type Prisma } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { buildConnectorsForAccount, makeRateLimitObserver } from '../connector-factory.js';
import { incrementProgress, recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import type { FetchItemPayload } from './payloads.js';

/** After this many attempts an item fails permanently (no rethrow / no retry). */
export const MAX_ITEM_ATTEMPTS = 5;

const TERMINAL_STATES = new Set(['preserved', 'processed', 'indexed', 'skipped']);

function toReadable(stream: ReadableStream<Uint8Array> | Uint8Array): Readable {
  if (stream instanceof Uint8Array) return Readable.from(Buffer.from(stream));
  return Readable.fromWeb(stream as unknown as WebReadableStream);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name
    .slice(dot + 1)
    .toLowerCase()
    .slice(0, 16);
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface FetchedContent {
  readable: Readable;
  emailMetadata?: EmailApiMetadata;
  contentType?: string;
  apiExportDerivative: boolean;
  exportFormat?: string;
  sourceNativeMimeType?: string;
}

/**
 * collection.fetch-item: download one provider item, preserve it as an
 * immutable content-addressed original, and record all evidence rows plus the
 * follow-on processing jobs in ONE transaction. Safe to retry at any point:
 * the CollectionItem state machine plus content-addressed promotion guarantee
 * no duplicate or lost evidence.
 */
export async function processCollectionFetchItem(
  ctx: WorkerContext,
  payload: FetchItemPayload,
): Promise<void> {
  const { tenantId, collectionId, custodianId, source, providerItemId } = payload;

  const loaded = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const item = await tx.collectionItem.findUnique({
      where: {
        collectionId_custodianId_source_providerItemId: {
          collectionId,
          custodianId,
          source,
          providerItemId,
        },
      },
    });
    if (item === null) return null;
    const collection = await tx.collection.findUnique({
      where: { id: collectionId },
      select: { status: true, connectorAccountId: true },
    });
    const custodian = await tx.custodian.findUnique({ where: { id: custodianId } });
    const connectorAccount = await tx.connectorAccount.findUnique({
      where: { id: collection?.connectorAccountId ?? collectionId },
      select: { provider: true },
    });
    return { item, collection, custodian, connectorAccount };
  });

  if (loaded === null || loaded.collection === null || loaded.custodian === null) {
    ctx.log.warn({ collectionId, providerItemId }, 'fetch-item: missing state; dropping');
    return;
  }
  const { item, collection, custodian } = loaded;
  if (TERMINAL_STATES.has(item.state)) return; // idempotent early return
  if (collection.status !== 'fetching') return; // paused/cancelled: bail quietly

  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.collectionItem.update({
      where: { id: item.id },
      data: { state: 'fetching', attempts: { increment: 1 } },
    }),
  );
  const attemptNumber = item.attempts + 1;

  try {
    const bundle = await buildConnectorsForAccount(ctx, {
      tenantId,
      connectorAccountId: collection.connectorAccountId,
      custodian: { externalId: custodian.externalId, email: custodian.email },
      onRateLimit: makeRateLimitObserver(ctx, tenantId, collectionId, custodianId, source),
    });

    let fetched: FetchedContent;
    const providerImmutableId = item.providerImmutableId;
    if (source === 'email') {
      const message = await bundle.email.fetchMessage(bundle.custodianRef, providerItemId);
      fetched = {
        readable: Readable.from(Buffer.from(message.rfc822)),
        emailMetadata: message.metadata,
        contentType: 'message/rfc822',
        apiExportDerivative: false,
      };
    } else {
      if (payload.entry === undefined) {
        throw new NonDownloadableError('drive item payload is missing its listing entry', {
          kind: 'unavailable_item',
          providerItemId,
        });
      }
      const entry = payload.entry as DriveEntry;
      const content = await bundle.drive.fetchContent(bundle.custodianRef, entry);
      fetched = {
        readable: toReadable(content.stream),
        contentType: content.contentType,
        apiExportDerivative: content.apiExportDerivative,
        exportFormat: content.exportFormat,
        sourceNativeMimeType: content.sourceNativeMimeType,
      };
    }

    // Stage + verify + promote to the immutable content-addressed original.
    const staged = await ctx.store.stageStream(tenantId, fetched.readable);
    const promoted = await ctx.store.promoteToOriginal(
      tenantId,
      staged.stagingKey,
      { sha256: staged.sha256, size: staged.size },
      { quarantine: false },
    );

    const entry = payload.entry;
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.evidenceBlob.createMany({
        data: [
          {
            tenantId,
            sha256: staged.sha256,
            size: BigInt(staged.size),
            objectKey: promoted.objectKey,
            providerChecksums: (entry?.checksums ?? {}) as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      const blob = await tx.evidenceBlob.findUniqueOrThrow({
        where: { tenantId_sha256: { tenantId, sha256: staged.sha256 } },
        select: { id: true },
      });

      const meta = fetched.emailMetadata;
      const isEmail = source === 'email';
      const name = isEmail
        ? meta?.subject !== undefined && meta.subject !== ''
          ? meta.subject
          : '(no subject)'
        : (entry?.name ?? providerItemId);
      const primaryDate = isEmail
        ? (parseDate(meta?.receivedAt) ?? parseDate(meta?.sentAt))
        : parseDate(entry?.modifiedAt);

      const evidence = await tx.evidenceItem.create({
        data: {
          tenantId,
          custodianId,
          collectionId,
          blobId: blob.id,
          kind: isEmail ? 'email' : 'file',
          name: name.slice(0, 500),
          extension: isEmail ? 'eml' : extensionOf(entry?.name ?? ''),
          mimeType: fetched.contentType ?? entry?.mimeType ?? 'application/octet-stream',
          size: BigInt(staged.size),
          sha256: staged.sha256,
          provider: loaded.connectorAccount?.provider ?? null,
          providerItemId,
          providerImmutableId,
          sourcePath: isEmail ? (meta?.folderId ?? '') : (entry?.path ?? ''),
          sourceLabels: meta?.labelIds ?? [],
          isApiExportDerivative: fetched.apiExportDerivative,
          primaryDate,
          sourceCreatedAt: parseDate(entry?.createdAt),
          sourceModifiedAt: isEmail ? null : parseDate(entry?.modifiedAt),
          acquiredAt: new Date(),
        },
        select: { id: true },
      });

      if (isEmail) {
        await tx.emailMetadata.create({
          data: {
            tenantId,
            evidenceItemId: evidence.id,
            subject: meta?.subject ?? '',
            messageId: meta?.internetMessageId ?? '',
            conversationId: meta?.conversationId ?? '',
            threadId: meta?.threadId ?? '',
            sentAt: parseDate(meta?.sentAt),
            receivedAt: parseDate(meta?.receivedAt),
            folder: meta?.folderId ?? '',
            labels: (meta?.labelIds ?? []).filter((l) => l !== GMAIL_ACCOUNT_FOLDER),
            categories: meta?.categories ?? [],
            // BCC is recorded ONLY when the provider API actually returned it.
            bccPresent: meta?.bccRecipients !== undefined && meta.bccRecipients.length > 0,
            hasAttachments: meta?.hasAttachments ?? false,
          },
        });
      } else {
        await tx.driveMetadata.create({
          data: {
            tenantId,
            evidenceItemId: evidence.id,
            driveId: entry?.driveId ?? '',
            path: entry?.path ?? '',
            parentProviderId: entry?.parentId ?? '',
            owners: (entry?.createdBy !== undefined
              ? [entry.createdBy]
              : []) as Prisma.InputJsonValue,
            permissionsSummary: (entry?.sharedSummary ?? []) as Prisma.InputJsonValue,
            isTrashed: entry?.trashed ?? false,
            sourceNativeMimeType: fetched.sourceNativeMimeType ?? '',
            exportFormat: fetched.exportFormat ?? '',
          },
        });
        if (fetched.apiExportDerivative) {
          await recordException(tx, {
            tenantId,
            collectionId,
            custodianId,
            source,
            providerItemId,
            kind: 'api_export_derivative',
            message:
              'preserved bytes are a provider API export of a native document, not a byte-identical native',
            detail: { exportFormat: fetched.exportFormat ?? '' },
          });
        }
      }

      await tx.collectionItem.update({
        where: { id: item.id },
        data: { state: 'preserved', evidenceItemId: evidence.id, lastError: '' },
      });
      await incrementProgress(tx, collectionId, custodianId, source, { fetched: 1, preserved: 1 });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'evidence.acquired',
        targetType: 'evidence_item',
        targetId: evidence.id,
        actorDisplay: 'worker',
        summary: {
          sha256: staged.sha256,
          size: staged.size,
          providerItemId,
          collectionId,
          apiExportDerivative: fetched.apiExportDerivative,
        },
      });

      const stage = isEmail ? 'parse' : 'extract';
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId,
            topic: isEmail ? QUEUES.processParse : QUEUES.processExtract,
            dedupKey: dedupKeys.processStage(stage, evidence.id, 1),
            payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
          },
          {
            tenantId,
            topic: QUEUES.processScan,
            dedupKey: dedupKeys.processStage('scan', evidence.id, 1),
            payload: { tenantId, evidenceItemId: evidence.id, version: 1 },
          },
        ],
        skipDuplicates: true,
      });

      // Nudge finalize when this was the last in-flight item.
      const remaining = await tx.collectionItem.count({
        where: { collectionId, state: { in: ['discovered', 'fetching'] } },
      });
      if (remaining === 0) {
        await tx.outboxEvent.createMany({
          data: [
            {
              tenantId,
              topic: QUEUES.collectionFinalize,
              dedupKey: `${dedupKeys.collectionFinalize(collectionId)}:chk:item`,
              payload: { tenantId, collectionId },
            },
          ],
          skipDuplicates: true,
        });
      }
    });
  } catch (err) {
    if (err instanceof NonDownloadableError) {
      await withTenantContext(ctx.prisma, tenantId, async (tx) => {
        await recordException(tx, {
          tenantId,
          collectionId,
          custodianId,
          source,
          providerItemId,
          kind: err.kind,
          message: sanitizeError(err),
        });
        await tx.collectionItem.update({
          where: { id: item.id },
          data: { state: 'skipped', lastError: sanitizeError(err) },
        });
        await incrementProgress(tx, collectionId, custodianId, source, { warnings: 1 });
      });
      return;
    }

    const message = sanitizeError(err);
    const permanent = attemptNumber >= MAX_ITEM_ATTEMPTS;
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.collectionItem.update({
        where: { id: item.id },
        data: { state: 'failed', lastError: message },
      });
      await recordException(tx, {
        tenantId,
        collectionId,
        custodianId,
        source,
        providerItemId,
        kind: 'api_error',
        message,
        detail: { attempt: attemptNumber, permanent },
      });
      await incrementProgress(
        tx,
        collectionId,
        custodianId,
        source,
        permanent ? { failures: 1 } : { retries: 1 },
      );
    });
    if (!permanent) throw err; // BullMQ backs off and retries
    ctx.log.error(
      { collectionId, providerItemId, attempts: attemptNumber },
      'fetch-item: permanently failed after max attempts',
    );
  }
}
