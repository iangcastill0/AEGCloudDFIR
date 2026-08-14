import { appendAuditEvent, withTenantContext } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { PayloadTooLargeError, readAllCapped } from '../streams.js';
import type { EvidenceStagePayload } from './payloads.js';

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_BYTES = 50 * 1024 * 1024;
const TIKA_TIMEOUT_MS = 120_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExtractDeps {
  fetchImpl?: FetchLike;
}

/** Mime types eligible for a follow-on OCR pass. */
export function needsOcr(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

/**
 * process.extract: text extraction for files and attachments through Apache
 * Tika (PUT /tika, Accept: text/plain). Encrypted/unsupported documents become
 * honest exceptions, never fake text. Idempotent via the ExtractedText row.
 */
export async function processExtract(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  deps: ExtractDeps = {},
): Promise<void> {
  const { tenantId, evidenceItemId } = payload;
  const version = payload.version;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  const item = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findUnique({
      where: { id: evidenceItemId },
      include: {
        blob: true,
        extractedTexts: { where: { kind: 'file_text' } },
      },
    }),
  );
  if (item === null) {
    ctx.log.warn({ evidenceItemId }, 'extract: evidence item not found; dropping');
    return;
  }
  if (item.kind === 'email') return; // emails go through process.parse
  if (item.extractedTexts.length > 0) {
    return; // already extracted (idempotent)
  }
  if (item.blob === null) return;

  let input: Buffer;
  try {
    const stream = await ctx.store.getStream(
      item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
      item.blob.objectKey,
    );
    input = await readAllCapped(stream, MAX_INPUT_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      await markExtractException(ctx, payload, item, 'unsupported_item', sanitizeError(err));
      return;
    }
    throw err;
  }

  const response = await fetchImpl(`${ctx.config.CDFIR_TIKA_URL.replace(/\/$/, '')}/tika`, {
    method: 'PUT',
    headers: {
      Accept: 'text/plain',
      'Content-Type': item.mimeType !== '' ? item.mimeType : 'application/octet-stream',
    },
    body: new Uint8Array(input),
    signal: AbortSignal.timeout(TIKA_TIMEOUT_MS),
  });

  if (response.status === 422) {
    const body = await response.text().catch(() => '');
    const encrypted = /encrypt/i.test(body) || /EncryptedDocument/i.test(body);
    await markExtractException(
      ctx,
      payload,
      item,
      encrypted ? 'encrypted_item' : 'unsupported_item',
      encrypted
        ? 'document is encrypted or password protected; text extraction is not possible'
        : 'document type is not supported by the text extractor',
    );
    return;
  }
  if (!response.ok) {
    throw new Error(`tika returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_TEXT_BYTES) {
    await markExtractException(
      ctx,
      payload,
      item,
      'unsupported_item',
      'extracted text exceeds the 50MB processing cap',
    );
    return;
  }
  let text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES);
  }
  const trimmed = text.trim();

  const put = await ctx.store.putDerivative(
    tenantId,
    evidenceItemId,
    'text',
    version,
    'file-text.txt',
    Buffer.from(trimmed, 'utf8'),
    'text/plain; charset=utf-8',
  );

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.extractedText.upsert({
      where: { evidenceItemId_kind_version: { evidenceItemId, kind: 'file_text', version } },
      create: {
        tenantId,
        evidenceItemId,
        kind: 'file_text',
        objectKey: put.objectKey,
        sha256: put.sha256,
        charCount: trimmed.length,
        extractorName: 'apache-tika',
        extractorVersion: 'server',
        version,
      },
      update: { objectKey: put.objectKey, sha256: put.sha256, charCount: trimmed.length },
    });
    await tx.evidenceItem.update({
      where: { id: evidenceItemId },
      data: { processingStatus: 'extracted' },
    });
    await appendAuditEvent(tx, {
      tenantId,
      action: 'evidence.text_extracted',
      targetType: 'evidence_item',
      targetId: evidenceItemId,
      actorDisplay: 'worker',
      summary: { extractor: 'apache-tika', charCount: trimmed.length },
    });
    await tx.outboxEvent.createMany({
      data: [
        ...(needsOcr(item.mimeType)
          ? [
              {
                tenantId,
                topic: QUEUES.processOcr,
                dedupKey: dedupKeys.processStage('ocr', evidenceItemId, version),
                payload: { tenantId, evidenceItemId, version },
              },
            ]
          : []),
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(evidenceItemId, version, 'extract'),
          payload: { tenantId, evidenceItemId, version },
        },
      ],
      skipDuplicates: true,
    });
  });
}

async function markExtractException(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  item: {
    id: string;
    collectionId: string | null;
    custodianId: string | null;
    providerItemId: string;
    name?: string;
    mimeType?: string;
    size?: number | bigint | null;
  },
  kind: 'encrypted_item' | 'unsupported_item',
  message: string,
): Promise<void> {
  await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
    if (item.collectionId !== null) {
      await recordException(tx, {
        tenantId: payload.tenantId,
        collectionId: item.collectionId,
        custodianId: item.custodianId ?? undefined,
        providerItemId: item.providerItemId,
        kind,
        message,
        // Identify the item in the ledger itself. providerItemId is empty for
        // anything extracted from a container (a PST attachment has no id in the
        // source system), so without this the exceptions report says only that
        // something failed — which is not enough for a reviewer to judge
        // materiality, or to disclose meaningfully.
        detail: {
          evidenceItemId: item.id,
          name: item.name ?? '',
          mimeType: item.mimeType ?? '',
          sizeBytes: item.size === null || item.size === undefined ? 0 : Number(item.size),
        },
      });
    }
    await tx.evidenceItem.update({
      where: { id: item.id },
      data: { processingStatus: 'exception', processingDetail: message.slice(0, 500) },
    });
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId: payload.tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(item.id, payload.version, 'extract-child'),
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
