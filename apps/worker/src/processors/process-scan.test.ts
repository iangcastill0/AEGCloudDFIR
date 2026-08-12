import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import type { ClamAvClient } from '../clamav.js';
import { processScan } from './process-scan.js';

const payload = { tenantId: TENANT, evidenceItemId: EVIDENCE, version: 1 };

function arm(f: FakeCtx, overrides: Record<string, unknown> = {}): void {
  f.tx.evidenceItem.findUnique.mockResolvedValue({
    id: EVIDENCE,
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
