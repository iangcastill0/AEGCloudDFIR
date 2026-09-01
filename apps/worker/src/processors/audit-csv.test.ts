import { describe, expect, it } from 'vitest';
import { AUDIT_CSV_COLUMNS, auditRowsFor } from './audit-csv.js';

const BATCH = {
  id: 'ev-1',
  kind: 'audit_batch',
  sha256: 'abc123',
  name: 'team_events page 1',
};

const RECORDS = [
  {
    providerRecordId: '2026-09-01T12:00:00Z#0',
    system: 'dropbox_team_log',
    workload: 'file_operations',
    operation: 'file_download',
    recordType: '',
    actorId: 'dbmid:AAA1',
    actorEmail: 'jane@example.com',
    actorIp: '203.0.113.7',
    targetId: 'id:f1',
    targetType: 'file',
    resultStatus: '',
    occurredAt: new Date('2026-09-01T12:00:00Z'),
  },
  {
    providerRecordId: '2026-09-01T12:00:05Z#1',
    system: 'dropbox_team_log',
    workload: 'logins',
    operation: 'login_success',
    recordType: '',
    actorId: 'dbmid:BBB2',
    actorEmail: 'raj@example.com',
    actorIp: '198.51.100.4',
    targetId: '',
    targetType: '',
    resultStatus: 'success',
    occurredAt: new Date('2026-09-01T12:00:05Z'),
  },
];

/**
 * A batch holds up to 1,000 events. One CSV row per batch would be almost
 * useless for analysis — "who downloaded what, when, from which IP" is a
 * question about events, not about pages of events.
 */
describe('auditRowsFor', () => {
  it('emits one row per event, not one per batch', () => {
    expect(auditRowsFor(BATCH, RECORDS)).toHaveLength(2);
  });

  it('carries the event fields a reviewer actually filters on', () => {
    const [first] = auditRowsFor(BATCH, RECORDS);
    expect(first?.auditOperation).toBe('file_download');
    expect(first?.auditWorkload).toBe('file_operations');
    expect(first?.auditActorEmail).toBe('jane@example.com');
    expect(first?.auditActorIp).toBe('203.0.113.7');
    expect(first?.auditOccurredAt).toBe('2026-09-01T12:00:00.000Z');
    expect(first?.auditTargetId).toBe('id:f1');
  });

  it('ties every row back to the preserved native by hash', () => {
    // The rows are derived. The batch is the evidence, and each event must be
    // traceable to the bytes it came out of, or the CSV is unciteable.
    for (const row of auditRowsFor(BATCH, RECORDS)) {
      expect(row.evidenceItemId).toBe('ev-1');
      expect(row.sha256).toBe('abc123');
    }
  });

  it('keeps a distinct provider record id per row', () => {
    const ids = auditRowsFor(BATCH, RECORDS).map((r) => r.auditRecordId);
    expect(new Set(ids).size).toBe(2);
  });

  it('still emits one row for a batch with no parsed events', () => {
    // A batch that parsed to nothing is a finding. Dropping it from the CSV
    // would make the export look like the page never existed.
    const rows = auditRowsFor(BATCH, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidenceItemId).toBe('ev-1');
    expect(rows[0]?.auditOperation).toBe('');
  });

  it('renders a missing timestamp as empty rather than a fake date', () => {
    const rows = auditRowsFor(BATCH, [{ ...RECORDS[0]!, occurredAt: null }]);
    expect(rows[0]?.auditOccurredAt).toBe('');
  });

  it('names every audit column it can produce', () => {
    // The column registry and the row builder must not drift: a column offered
    // but never filled produces a silently empty spreadsheet column.
    const [row] = auditRowsFor(BATCH, RECORDS);
    for (const column of AUDIT_CSV_COLUMNS) {
      expect(Object.keys(row ?? {}), column).toContain(column);
    }
  });
});
