import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TenantRole } from '@aeg-clouddfir/database';
import { ImportsService } from './imports.service.js';
import {
  CASE_ID,
  ITEM_A,
  TENANT_ID,
  USER_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
} from '../testing/mocks.js';

function store() {
  return {
    stageStream: vi.fn().mockResolvedValue({
      stagingKey: `tenants/${TENANT_ID}/staging/x`,
      sha256: 'a'.repeat(64),
      size: 12,
    }),
    promoteToOriginal: vi.fn().mockResolvedValue({
      objectKey: `tenants/${TENANT_ID}/originals/sha256/aa/${'a'.repeat(64)}`,
    }),
    getStream: vi.fn(),
  };
}

describe('ImportsService', () => {
  it('preserves an upload and queues its malware scan atomically', async () => {
    const outboxCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const importCreate = vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      name: 'evidence.zip',
      status: 'uploaded',
      sourceEvidenceItemId: ITEM_A,
      createdById: USER_ID,
      parserVersion: '',
      artifactCount: 0,
      error: '',
      createdAt: new Date('2026-09-24T12:00:00Z'),
      updatedAt: new Date('2026-09-24T12:00:00Z'),
      cases: [],
    });
    const prisma = fakePrisma({
      evidenceBlob: {
        createMany: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'blob-1' }),
      },
      evidenceItem: {
        create: vi.fn().mockResolvedValue({ id: ITEM_A, version: 1 }),
        update: vi.fn(),
      },
      forensicImport: { create: importCreate },
      outboxEvent: { createMany: outboxCreateMany },
    });
    const objectStore = store();
    const audit = fakeAudit();
    const service = new ImportsService(prisma, objectStore as never, audit.service);
    const file = Readable.from('source') as Readable & { truncated: boolean };
    file.truncated = false;
    const request = fakeRequest({
      isMultipart: () => true,
      file: async () => ({
        filename: 'evidence.zip',
        mimetype: 'application/zip',
        file,
      }),
    });

    const result = await service.upload(makeAuth([TenantRole.case_manager]), request);

    expect(result.id).toBe('99999999-9999-4999-8999-999999999999');
    const topics = (outboxCreateMany.mock.calls[0]?.[0]?.data as { topic: string }[]).map(
      (row) => row.topic,
    );
    expect(topics).toEqual(['process.scan']);
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'import.uploaded' }),
    );
  });

  it('adds every import item to a case in bounded pages', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const ids = Array.from(
      { length: 2_001 },
      (_, i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    const evidenceFindMany = vi
      .fn()
      .mockResolvedValueOnce(ids.slice(0, 1000).map((id) => ({ id })))
      .mockResolvedValueOnce(ids.slice(1000, 2000).map((id) => ({ id })))
      .mockResolvedValueOnce(ids.slice(2000).map((id) => ({ id })));
    const caseItemCreateMany = vi.fn(async ({ data }: { data: unknown[] }) => ({
      count: data.length,
    }));
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: importId,
          createdById: USER_ID,
          cases: [],
        }),
      },
      case: { findFirst: vi.fn().mockResolvedValue({ id: CASE_ID }) },
      importCase: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      evidenceItem: { findMany: evidenceFindMany },
      caseItem: { createMany: caseItemCreateMany },
      outboxEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });
    const audit = fakeAudit();
    const service = new ImportsService(prisma, store() as never, audit.service);

    const result = await service.attach(
      makeAuth([TenantRole.case_manager]),
      importId,
      { caseId: CASE_ID },
      fakeRequest(),
    );

    expect(result.itemsAdded).toBe(2_001);
    expect(caseItemCreateMany).toHaveBeenCalledTimes(3);
    expect(
      caseItemCreateMany.mock.calls.every((call) => (call[0]?.data as unknown[]).length <= 1000),
    ).toBe(true);
  });

  it('re-runs malware scanning before retrying an import whose scan failed', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const outboxCreate = vi.fn().mockResolvedValue({ id: 'event-1' });
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: importId,
          name: 'sample.zip',
          status: 'failed',
          sourceEvidenceItemId: ITEM_A,
          createdById: USER_ID,
          parserVersion: '',
          artifactCount: 0,
          error: 'source malware scan did not complete',
          createdAt: new Date('2026-09-24T12:00:00Z'),
          updatedAt: new Date('2026-09-24T12:00:00Z'),
          cases: [],
        }),
        update: vi.fn(),
      },
      evidenceItem: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ malwareStatus: 'scan_failed', version: 1 }),
      },
      outboxEvent: { create: outboxCreate },
    });
    const audit = fakeAudit();
    const service = new ImportsService(prisma, store() as never, audit.service);

    await service.retry(makeAuth([TenantRole.case_manager]), importId, fakeRequest());

    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          topic: 'process.scan',
          payload: { tenantId: TENANT_ID, evidenceItemId: ITEM_A, version: 1 },
        }),
      }),
    );
  });
});
