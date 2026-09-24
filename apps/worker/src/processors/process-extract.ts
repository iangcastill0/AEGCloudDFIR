import { appendAuditEvent, withTenantContext } from '@aeg-clouddfir/database';
import { sanitizeError, type WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { convertToPlainText, isConvertible } from './soffice.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { isImageOcr, ocrDecision } from './ocr-policy.js';
import { PayloadTooLargeError, readAllCapped } from '../streams.js';
import { isObjectNotFoundError, recordMissingObject } from './missing-object.js';
import type { EvidenceStagePayload } from './payloads.js';

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_BYTES = 50 * 1024 * 1024;
const TIKA_TIMEOUT_MS = 120_000;
/** Recorded as the extractor when the LibreOffice fallback recovers text. */
const SOFFICE_EXTRACTOR = 'libreoffice';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExtractDeps {
  fetchImpl?: FetchLike;
}

/** Mime types eligible for a follow-on OCR pass. */
/**
 * Kept as a thin wrapper over ocrDecision so existing callers and tests keep
 * working; the rule itself, including the low-text fallback for documents that
 * are really scans, lives in ocr-policy.ts.
 */
export function needsOcr(mimeType: string, extractedChars = 0): boolean {
  return ocrDecision({ mimeType, extractedChars }).run;
}

/**
 * The outbox row(s) that queue OCR for this item, on the queue its cost class
 * belongs to. Empty when the item needs no OCR at all.
 *
 * The dedup key stays `ocr:<id>:v<n>` across BOTH queues. It has to: an item
 * is one piece of work whichever lane runs it, and a key that encoded the lane
 * would let the same item be OCRed twice if the routing rule ever changed.
 */
export function ocrOutboxRows(
  tenantId: string,
  evidenceItemId: string,
  version: number,
  mimeType: string,
  extractedChars: number,
): { tenantId: string; topic: string; dedupKey: string; payload: object }[] {
  const decision = ocrDecision({ mimeType, extractedChars });
  if (!decision.run) return [];
  return [
    {
      tenantId,
      topic: isImageOcr(decision) ? QUEUES.processOcrImage : QUEUES.processOcr,
      dedupKey: dedupKeys.processStage('ocr', evidenceItemId, version),
      payload: { tenantId, evidenceItemId, version },
    },
  ];
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

  const bucket =
    item.blob.storageClass === 'quarantine' ? ('quarantine' as const) : ('evidence' as const);

  let input: Buffer;
  try {
    const stream = await ctx.store.getStream(bucket, item.blob.objectKey);
    input = await readAllCapped(stream, MAX_INPUT_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      await markExtractException(ctx, payload, item, 'unsupported_item', sanitizeError(err));
      return;
    }
    // A missing object was rethrown here, so BullMQ retried eight times with
    // backoff against a key that will never come back, and the item finished as
    // a generic job failure. It is a permanent, nameable condition; record it
    // and stop.
    if (isObjectNotFoundError(err)) {
      await recordMissingObject(ctx, {
        tenantId,
        item,
        version,
        stage: 'extract',
        bucket,
        objectKey: item.blob.objectKey,
      });
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

    // Encrypted documents are not retried: LibreOffice cannot open them either
    // without the password, so a second attempt only burns a process spawn and
    // muddies the exception with a misleading second failure.
    if (
      !encrypted &&
      ctx.config.CDFIR_SOFFICE_FALLBACK &&
      isConvertible(item.mimeType, item.name)
    ) {
      const converted = await convertToPlainText(input, item.mimeType, item.name, {
        timeoutMs: ctx.config.CDFIR_SOFFICE_TIMEOUT_MS,
        maxTextBytes: MAX_TEXT_BYTES,
      });
      if (converted.ok) {
        ctx.log.info(
          { evidenceItemId, mimeType: item.mimeType },
          'extract: tika declined the format; libreoffice recovered the text',
        );
        await persistExtractedText(
          ctx,
          payload,
          item,
          version,
          converted.text,
          SOFFICE_EXTRACTOR,
          'headless',
        );
        return;
      }
      ctx.log.info(
        { evidenceItemId, mimeType: item.mimeType, reason: converted.reason },
        'extract: libreoffice fallback did not recover text',
      );
      await markExtractException(
        ctx,
        payload,
        item,
        'unsupported_item',
        // Say that the fallback ran. An exceptions report that reads "not
        // supported" when a second extractor was also tried understates the
        // effort made, which matters if the omission is ever challenged.
        `document type is not supported by the text extractor; LibreOffice fallback also failed (${converted.reason})`,
      );
      return;
    }

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
  await persistExtractedText(ctx, payload, item, version, text, 'apache-tika', 'server');
}

/**
 * Store extracted text and fan out to OCR and indexing.
 *
 * `extractorName` is a parameter rather than a constant: text recovered by the
 * LibreOffice fallback must be attributable to it, both on the row and in the
 * audit event, so a reviewer can see how a document's text was obtained.
 */
async function persistExtractedText(
  ctx: WorkerContext,
  payload: EvidenceStagePayload,
  item: { id: string; mimeType: string },
  version: number,
  text: string,
  extractorName: string,
  extractorVersion: string,
): Promise<void> {
  const { tenantId } = payload;
  const evidenceItemId = item.id;
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
        extractorName,
        extractorVersion,
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
      summary: { extractor: extractorName, charCount: trimmed.length },
    });
    await tx.outboxEvent.createMany({
      data: [
        // The character count matters now: a document that extracted to nothing
        // is very likely a photograph of a page, and is otherwise unsearchable.
        //
        // Routed by cost class. Images go to their own queue so that tens of
        // thousands of them cannot sit in front of a PDF, and so that one long
        // PDF cannot sit in front of them. Same processor either side.
        ...ocrOutboxRows(tenantId, evidenceItemId, version, item.mimeType, trimmed.length),
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
