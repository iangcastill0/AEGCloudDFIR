/**
 * Audit events as CSV rows — one row per event, not one per batch.
 *
 * An audit batch is a page of up to 1,000 provider events preserved as a single
 * evidence item. Exporting one CSV row per batch is nearly useless: the
 * questions a reviewer asks — who downloaded what, when, from which IP — are
 * about events, and answering them from a spreadsheet of page summaries means
 * parsing the JSON by hand.
 *
 * Every row carries the batch's `evidenceItemId` and `sha256`. The rows are
 * derived; the batch is the evidence. An event that cannot be traced back to
 * the bytes it came from is not citable, so the link is not optional.
 *
 * Pure: no database, no store.
 */

/** Columns this expansion can fill. Registered so the two cannot drift. */
export const AUDIT_CSV_COLUMNS: readonly string[] = [
  'auditRecordId',
  'auditSystem',
  'auditOccurredAt',
  'auditActorEmail',
  'auditActorId',
  'auditActorIp',
  'auditWorkload',
  'auditOperation',
  'auditRecordType',
  'auditTargetId',
  'auditTargetType',
  'auditResultStatus',
];

export interface AuditCsvBatch {
  id: string;
  kind: string;
  sha256: string;
  name: string;
}

export interface AuditCsvRecord {
  providerRecordId: string;
  system: string;
  workload: string;
  operation: string;
  recordType: string;
  actorId: string;
  actorEmail: string;
  actorIp: string;
  targetId: string;
  targetType: string;
  resultStatus: string;
  occurredAt: Date | null;
}

/**
 * Rows for one audit batch.
 *
 * A batch that parsed to no events still produces a row. Dropping it would make
 * the export look as though the page had never been collected, which is exactly
 * the kind of quiet gap this product exists to avoid.
 */
export function auditRowsFor(
  batch: AuditCsvBatch,
  records: readonly AuditCsvRecord[],
): Record<string, string>[] {
  const identity = {
    evidenceItemId: batch.id,
    kind: batch.kind,
    name: batch.name,
    sha256: batch.sha256,
  };

  if (records.length === 0) {
    const empty: Record<string, string> = { ...identity };
    for (const column of AUDIT_CSV_COLUMNS) empty[column] = '';
    return [empty];
  }

  return records.map((record) => ({
    ...identity,
    auditRecordId: record.providerRecordId,
    auditSystem: record.system,
    // Empty, never a substituted "now": a fabricated timestamp on an evidence
    // row is worse than a blank one.
    auditOccurredAt: record.occurredAt === null ? '' : record.occurredAt.toISOString(),
    auditActorEmail: record.actorEmail,
    auditActorId: record.actorId,
    auditActorIp: record.actorIp,
    auditWorkload: record.workload,
    auditOperation: record.operation,
    auditRecordType: record.recordType,
    auditTargetId: record.targetId,
    auditTargetType: record.targetType,
    auditResultStatus: record.resultStatus,
  }));
}
