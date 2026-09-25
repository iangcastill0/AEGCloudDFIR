import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE,
  TENANT,
  createManyRows,
  fakeCtx,
  silentLog,
  type FakeCtx,
} from '../testing/fakes.js';
import type { ClamAvClient } from '../clamav.js';
import { processScan } from './process-scan.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
    name: 'report.pdf',
    collectionId: null,
    custodianId: null,
    providerItemId: 'p1',
    malwareScans: [],
    blob: {
      id: 'blob-1',
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
      storageClass: 'original',
    },
    ...overrides,
  });
  f.store.getStream.mockResolvedValue(Readable.from(Buffer.from('bytes')));
}

/** The error shape S3 throws for a key that is not in the bucket. */
function noSuchKey(): Error {
  const err = new Error('The specified key does not exist.') as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = 'NoSuchKey';
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

/** Every log line emitted by the run, as `message` strings. */
function logged(level: 'warn' | 'error'): string[] {
  return silentLog[level].mock.calls.map((call) => String(call[1]));
}

// silentLog is shared across every fakeCtx in the suite and nothing resets it.
beforeEach(() => {
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
});

function clam(result: { infected: boolean; signature: string }): ClamAvClient {
  return {
    version: vi.fn().mockResolvedValue({ engineVersion: 'ClamAV 1.3', signatureVersion: '27310' }),
    scanStream: vi.fn().mockResolvedValue(result),
  };
}

describe('processScan', () => {
  it('skips items that already have a scan row', async () => {
    const f = fakeCtx();
    arm(f, { malwareScans: [{ id: 's1' }] });
    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });
    expect(f.tx.malwareScan.create).not.toHaveBeenCalled();
  });

  it('allows an explicit retry after a prior scan_failed result', async () => {
    const f = fakeCtx();
    arm(f, { malwareScans: [{ id: 's1', result: 'scan_failed' }] });
    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });
    expect(f.tx.malwareScan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ result: 'clean' }) }),
    );
  });

  it('records scan_failed without throwing when clamav is disabled', async () => {
    const f = fakeCtx({ config: { CDFIR_CLAMAV_ENABLED: false } });
    arm(f);
    await expect(processScan(f.ctx, payload)).resolves.toBeUndefined();
    expect(f.tx.malwareScan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ result: 'scan_failed' }) }),
    );
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { malwareStatus: 'scan_failed' } }),
    );
  });

  it('records scan_failed without throwing when clamd is unreachable', async () => {
    const f = fakeCtx();
    arm(f);
    const broken: ClamAvClient = {
      version: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scanStream: vi.fn(),
    };
    await expect(
      processScan(f.ctx, payload, { clamFactory: () => broken }),
    ).resolves.toBeUndefined();
    expect(f.tx.malwareScan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ result: 'scan_failed' }) }),
    );
  });

  it('queues Crush analysis only after an import source scan settles', async () => {
    const f = fakeCtx();
    arm(f, {
      importId: '99999999-9999-4999-8999-999999999999',
      sourceForImport: { id: '99999999-9999-4999-8999-999999999999' },
    });

    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });

    expect(createManyRows(f.tx.outboxEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: 'import.analyze',
          payload: {
            tenantId: TENANT,
            importId: '99999999-9999-4999-8999-999999999999',
          },
        }),
      ]),
    );
  });

  it('does not burn the analyze key when an import source scan fails', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const f = fakeCtx();
    arm(f, { importId, sourceForImport: { id: importId } });
    const broken: ClamAvClient = {
      version: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scanStream: vi.fn(),
    };

    await processScan(f.ctx, payload, { clamFactory: () => broken });

    expect(createManyRows(f.tx.outboxEvent).map((row) => row.topic)).not.toContain(
      'import.analyze',
    );
    expect(f.tx.forensicImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', error: 'source malware scan did not complete' },
      }),
    );
  });

  it('a later clean rescan of an import source still queues Crush analysis', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const f = fakeCtx();
    arm(f, {
      importId,
      sourceForImport: { id: importId },
      malwareScans: [{ id: 's1', result: 'scan_failed' }],
    });

    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });

    expect(createManyRows(f.tx.outboxEvent)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: 'import.analyze',
          payload: { tenantId: TENANT, importId },
        }),
      ]),
    );
  });

  it('still queues Crush analysis when ClamAV is off and the source records scan_failed', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const f = fakeCtx({ config: { CDFIR_CLAMAV_ENABLED: false } });
    arm(f, { importId, sourceForImport: { id: importId } });

    await processScan(f.ctx, payload);

    expect(createManyRows(f.tx.outboxEvent)).toEqual(
      expect.arrayContaining([expect.objectContaining({ topic: 'import.analyze' })]),
    );
  });

  it('gives each import-source scan a fresh analyze key so Retry is not dropped', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const f = fakeCtx({ config: { CDFIR_CLAMAV_ENABLED: false } });
    arm(f, { importId, sourceForImport: { id: importId } });
    await processScan(f.ctx, payload);

    arm(f, {
      importId,
      sourceForImport: { id: importId },
      malwareScans: [{ id: 's1', result: 'scan_failed' }],
    });
    await processScan(f.ctx, payload);

    const keys = createManyRows(f.tx.outboxEvent)
      .filter((row) => row.topic === 'import.analyze')
      .map((row) => row.dedupKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
  });

  it('queues member processing only after that extracted member scans clean', async () => {
    const f = fakeCtx();
    arm(f, {
      importId: '99999999-9999-4999-8999-999999999999',
      sourceForImport: null,
    });

    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });

    const topics = createManyRows(f.tx.outboxEvent).map((row) => row.topic);
    expect(topics).toEqual(
      expect.arrayContaining(['process.extract', 'process.preview', 'search.index']),
    );
    expect(topics).not.toContain('import.analyze');
  });

  it('a missing evidence object is object_missing, NOT a scan failure', async () => {
    // The defect, in one test. One try/catch used to wrap clam.version(),
    // store.getStream() and clam.scanStream(), so evidence that no longer
    // exists was recorded exactly like a ClamAV restart: malwareStatus
    // scan_failed, logged 'clamav unavailable'. 32 items hid behind that for
    // twelve days until a 130 GiB export read every byte.
    const f = fakeCtx();
    arm(f);
    f.store.getStream.mockRejectedValue(noSuchKey());

    await expect(
      processScan(f.ctx, payload, { clamFactory: () => clam({ infected: false, signature: '' }) }),
    ).resolves.toBeUndefined();

    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ malwareStatus: 'object_missing' }),
      }),
    );
    // No scan happened, so no scan row. Writing one would also satisfy the
    // idempotency guard and make the item permanently unrescannable.
    expect(f.tx.malwareScan.create).not.toHaveBeenCalled();
    expect(logged('warn')).not.toContain('scan: clamav unavailable');
    expect(logged('error')).toContain('evidence object is MISSING from object storage');
  });

  it('a missing object also lands in the collection exceptions ledger', async () => {
    const f = fakeCtx();
    arm(f, { collectionId: 'c1' });
    f.store.getStream.mockRejectedValue(noSuchKey());

    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });

    const row = f.tx.collectionException.create.mock.calls[0]?.[0] as {
      data: { kind: string; message: string };
    };
    expect(row.data.kind).toBe('object_missing');
    expect(row.data.message).toContain('MISSING');
  });

  it('a clamav outage stays an ordinary, unalarming scan_failed', async () => {
    // Requirement, not an accident: a ClamAV restart must not raise a flood of
    // evidence-integrity alerts.
    const f = fakeCtx();
    arm(f);
    const broken: ClamAvClient = {
      version: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scanStream: vi.fn(),
    };

    await processScan(f.ctx, payload, { clamFactory: () => broken });

    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { malwareStatus: 'scan_failed' } }),
    );
    expect(logged('warn')).toContain('scan: clamav unavailable');
    expect(silentLog.error).not.toHaveBeenCalled();
  });

  it('a storage read failure that is not a missing key is scan_failed, but is not blamed on clamav', async () => {
    // AccessDenied is not a deleted object and must not be reported as one;
    // it is also not clamav's fault and must not be reported as that either.
    const f = fakeCtx();
    arm(f);
    const denied = new Error('Access Denied') as Error & { $metadata: { httpStatusCode: number } };
    denied.name = 'AccessDenied';
    denied.$metadata = { httpStatusCode: 403 };
    f.store.getStream.mockRejectedValue(denied);

    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });

    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { malwareStatus: 'scan_failed' } }),
    );
    expect(logged('warn')).toContain('scan: could not read the evidence object from storage');
    expect(logged('warn')).not.toContain('scan: clamav unavailable');
    expect(silentLog.error).not.toHaveBeenCalled();
  });

  it('clean result marks the item clean and re-indexes', async () => {
    const f = fakeCtx();
    arm(f);
    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: false, signature: '' }),
    });
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { malwareStatus: 'clean' } }),
    );
    expect(f.tx.outboxEvent.createMany).toHaveBeenCalled();
  });

  it('infected item sharing its blob with another item is marked infected but the object stays', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.evidenceItem.count.mockResolvedValue(1); // another evidence item shares the blob
    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: true, signature: 'Eicar-Test-Signature' }),
    });
    // No quarantine copy, no blob mutation.
    expect(f.store.stageStream).not.toHaveBeenCalled();
    expect(f.store.promoteToOriginal).not.toHaveBeenCalled();
    expect(f.tx.evidenceBlob.update).not.toHaveBeenCalled();
    // But the item itself is honestly marked infected.
    expect(f.tx.evidenceItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { malwareStatus: 'infected' } }),
    );
    const audit = f.tx.auditEvent.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data['action']).toBe('evidence.quarantined');
    expect(audit.data['summary']).toMatchObject({ sharedBlob: true, objectMoved: false });
  });

  it('infected sole-owner blob is copied to quarantine and the blob row is repointed', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.evidenceItem.count.mockResolvedValue(0);
    f.store.promoteToOriginal.mockResolvedValue({
      objectKey: `tenants/${TENANT}/quarantine/sha256/aa/${'a'.repeat(64)}`,
      bucket: 'quarantine-test',
    });
    await processScan(f.ctx, payload, {
      clamFactory: () => clam({ infected: true, signature: 'Eicar-Test-Signature' }),
    });
    expect(f.store.promoteToOriginal).toHaveBeenCalledWith(
      TENANT,
      expect.any(String),
      expect.any(Object),
      { quarantine: true },
    );
    expect(f.tx.evidenceBlob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ storageClass: 'quarantine' }),
      }),
    );
  });
});
