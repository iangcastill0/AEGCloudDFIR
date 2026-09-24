/**
 * One place to say "the evidence object is not in storage", loudly.
 *
 * Why this file exists
 * --------------------
 * Four processors read evidence bytes (scan, extract, ocr, preview) and every
 * one of them used to fold a missing object into some other, calmer outcome:
 *
 *   process.scan     -> malwareStatus 'scan_failed', logged 'clamav unavailable'
 *   process.extract  -> rethrown, so BullMQ retried a permanently absent object
 *   process.ocr      -> same
 *   process.preview  -> exception kind 'other', "The stored file could not be read"
 *
 * So the worst thing that can happen to a forensic platform — collected
 * evidence that is no longer there — was reported in the words of a transient
 * hiccup. On 2026-09-22 that hid 32 items for twelve days, until a 130 GiB
 * export read every byte and found them.
 *
 * A missing object is different in kind from every other failure here. It is
 * not retryable by the pipeline, nothing downstream can fix it, and it changes
 * what the product may honestly claim about a collection. So it gets its own
 * enum value in two places, its own log line, and one shared writer so the four
 * stages cannot drift apart again.
 */
import { withTenantContext } from '@aeg-clouddfir/database';
import { isObjectNotFoundError } from '@aeg-clouddfir/evidence';
import type { WorkerContext } from '../context.js';
import { recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';

export { isObjectNotFoundError };

/** The stage that noticed. Appears in the log, the ledger and the dedup key. */
export type MissingObjectStage = 'scan' | 'extract' | 'ocr' | 'preview';

/** The item fields the recorder needs; every caller already loads these. */
export interface MissingObjectItem {
  id: string;
  collectionId: string | null;
  custodianId: string | null;
  providerItemId: string;
  name: string;
}

export interface RecordMissingObjectInput {
  tenantId: string;
  item: MissingObjectItem;
  version: number;
  stage: MissingObjectStage;
  bucket: 'evidence' | 'quarantine';
  objectKey: string;
  /**
   * Also set malwareStatus to 'object_missing'.
   *
   * ONLY process.scan passes this. An item that scanned clean months ago and
   * lost its bytes yesterday was genuinely scanned clean, and overwriting that
   * verdict from an unrelated stage would destroy a true fact and contradict
   * its own MalwareScan row.
   */
  malwareUnscannable?: boolean;
}

/** What the item, the ledger and the operator all get told. */
export function missingObjectMessage(bucket: string, objectKey: string): string {
  return (
    `evidence object is MISSING from ${bucket} object storage (key ${objectKey}). ` +
    'The bytes were collected and recorded but cannot be read now, so this item ' +
    'cannot be scanned, extracted, previewed, produced or exported. This is not a ' +
    'processing failure and retrying will not fix it.'
  );
}

/**
 * Record a missing evidence object: loud log, honest item state, ledger row,
 * and a re-index so Review stops showing the item as ordinary.
 *
 * Never throws for the caller's benefit — the caller has already lost the
 * bytes; failing its job on top of that just buries the record in a retry loop.
 */
export async function recordMissingObject(
  ctx: WorkerContext,
  input: RecordMissingObjectInput,
): Promise<void> {
  const { tenantId, item, version, stage, bucket, objectKey } = input;
  const message = missingObjectMessage(bucket, objectKey);

  // error, not warn: this is the one condition here that means evidence is
  // lost. It must be findable in a log search that ignores warnings.
  ctx.log.error(
    {
      evidenceItemId: item.id,
      collectionId: item.collectionId,
      objectKey,
      bucket,
      stage,
    },
    'evidence object is MISSING from object storage',
  );

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.evidenceItem.update({
      where: { id: item.id },
      data: {
        processingStatus: 'exception',
        processingDetail: message.slice(0, 500),
        ...(input.malwareUnscannable === true ? { malwareStatus: 'object_missing' as const } : {}),
      },
    });

    if (item.collectionId !== null) {
      // Up to three stages hit the same absent object, seconds apart. One item
      // with no bytes is ONE problem; three ledger rows would treble the count
      // an operator and a disclosure report read off this table.
      const already = await tx.collectionException.findFirst({
        where: {
          collectionId: item.collectionId,
          kind: 'object_missing',
          detail: { path: ['evidenceItemId'], equals: item.id },
        },
        select: { id: true },
      });
      if (already === null) {
        await recordException(tx, {
          tenantId,
          collectionId: item.collectionId,
          custodianId: item.custodianId ?? undefined,
          providerItemId: item.providerItemId,
          kind: 'object_missing',
          message,
          detail: {
            evidenceItemId: item.id,
            name: item.name,
            objectKey,
            bucket,
            foundBy: stage,
          },
        });
      }
    }

    // The new status has to reach search, or Review keeps presenting the item
    // as if its bytes were there. Stage is in the dedup key so this is not
    // collapsed against another stage's re-index of the same version.
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          topic: QUEUES.searchIndex,
          dedupKey: dedupKeys.searchIndex(item.id, version, `${stage}-object-missing`),
          payload: { tenantId, evidenceItemId: item.id, version },
        },
      ],
      skipDuplicates: true,
    });
  });
}
