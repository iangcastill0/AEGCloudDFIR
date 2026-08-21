import { describe, expect, it, vi } from 'vitest';
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { MalwareStatus, TenantRole } from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import { EvidenceService } from './evidence.service.js';
import {
  ITEM_A,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const OBJECT_KEY = `tenants/${TENANT_ID}/originals/sha256/ab/cd/abcd`;

function makeStore() {
  const presignGet = vi.fn(async () => 'https://signed.example/url?sig=SECRET');
  return { store: { presignGet } as unknown as EvidenceObjectStore, presignGet };
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_A,
    tenantId: TENANT_ID,
    name: 'report.pdf',
    size: 123n,
    malwareStatus: MalwareStatus.clean,
    blob: { objectKey: OBJECT_KEY, sha256: 'abcd' },
    ...overrides,
  };
}

function makeService(models: Record<string, unknown>, store: EvidenceObjectStore) {
  const audit = fakeAudit();
  const service = new EvidenceService(fakePrisma(models), testConfig(), store, audit.service);
  return { service, audit };
}

describe('EvidenceService authorization', () => {
  it('returns 404 for a nonexistent or cross-tenant id (no existence leakage)', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => null) } },
      store,
    );
    await expect(
      service.native(makeAuth([TenantRole.case_manager]), ITEM_A, false, fakeRequest()),
    ).rejects.toThrow(NotFoundException);
  });

  it('read_only callers get 404 for items outside their assigned cases', async () => {
    const { store } = makeStore();
    const caseItemCount = vi.fn(async () => 0);
    const findFirst = vi.fn(async () => baseItem());
    const { service } = makeService(
      { caseItem: { count: caseItemCount }, evidenceItem: { findFirst } },
      store,
    );
    await expect(
      service.native(makeAuth([TenantRole.read_only]), ITEM_A, false, fakeRequest()),
    ).rejects.toThrow(NotFoundException);
    expect(caseItemCount).toHaveBeenCalledTimes(1);
    // The item row is never even loaded once the ACL check fails.
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('EvidenceService.native', () => {
  it('presigns the original blob and audits the download', async () => {
    const { store, presignGet } = makeStore();
    const { service, audit } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => baseItem()) } },
      store,
    );
    const result = await service.native(
      makeAuth([TenantRole.case_manager]),
      ITEM_A,
      false,
      fakeRequest(),
    );
    expect(result.url).toContain('https://signed.example');
    expect(result.sha256).toBe('abcd');
    expect(presignGet).toHaveBeenCalledWith(TENANT_ID, OBJECT_KEY, { ttlSeconds: 300 });
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'evidence.native_downloaded',
        targetType: 'evidence_item',
        targetId: ITEM_A,
      }),
    );
    // The presigned URL never reaches the audit trail.
    for (const call of audit.appendTx.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('sig=SECRET');
    }
  });

  it('locks infected items with 423 for non-admins', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      {
        evidenceItem: {
          findFirst: vi.fn(async () => baseItem({ malwareStatus: MalwareStatus.infected })),
        },
      },
      store,
    );
    let caught: HttpException | undefined;
    try {
      await service.native(makeAuth([TenantRole.case_manager]), ITEM_A, true, fakeRequest());
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught?.getStatus()).toBe(423);
  });

  it('locks infected items even for org_admin without the explicit confirmation', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      {
        evidenceItem: {
          findFirst: vi.fn(async () => baseItem({ malwareStatus: MalwareStatus.infected })),
        },
      },
      store,
    );
    let caught: HttpException | undefined;
    try {
      await service.native(makeAuth([TenantRole.org_admin]), ITEM_A, false, fakeRequest());
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught?.getStatus()).toBe(423);
  });

  it('org_admin + confirmDangerous=1 succeeds and audits the override separately', async () => {
    const { store } = makeStore();
    const { service, audit } = makeService(
      {
        evidenceItem: {
          findFirst: vi.fn(async () => baseItem({ malwareStatus: MalwareStatus.infected })),
        },
      },
      store,
    );
    await service.native(makeAuth([TenantRole.org_admin]), ITEM_A, true, fakeRequest());
    const actions = audit.appendTx.mock.calls.map((call) => (call[1] as { action: string }).action);
    expect(actions).toContain('evidence.infected_download_override');
    expect(actions).toContain('evidence.native_downloaded');
  });

  it('409s when the item has no stored native', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => baseItem({ blob: null })) } },
      store,
    );
    await expect(
      service.native(makeAuth([TenantRole.case_manager]), ITEM_A, false, fakeRequest()),
    ).rejects.toThrow(ConflictException);
  });
});

describe('EvidenceService.detail — the people on a message', () => {
  function emailItem() {
    return {
      ...baseItem({ name: 'Q3 numbers', kind: 'email' }),
      extension: 'eml',
      mimeType: 'message/rfc822',
      sha256: 'abcd',
      custodian: { email: 'alice@example.com' },
      sourcePath: '/Inbox/Q3',
      sourceLabels: [],
      primaryDate: new Date('2026-03-04T05:06:07Z'),
      acquiredAt: new Date('2026-03-05T00:00:00Z'),
      processingStatus: 'complete',
      processingDetail: '',
      isApiExportDerivative: false,
      provider: 'microsoft',
      tagAssignments: [],
      driveMetadata: null,
      emailMetadata: {
        subject: 'Q3 numbers',
        messageId: '<a@b>',
        inReplyTo: '',
        threadId: '',
        conversationId: '',
        sentAt: new Date('2026-03-04T05:06:07Z'),
        receivedAt: null,
        rawDateHeader: 'Wed, 4 Mar 2026 05:06:07 +0000',
        folder: 'Inbox',
        labels: [],
        categories: [],
        flags: [],
        bccPresent: true,
        hasAttachments: false,
        isEncrypted: false,
        smimeType: '',
      },
      participants: [
        { role: 'from', rawName: 'Alice Smith', rawAddress: 'alice@example.com', position: 0 },
        { role: 'to', rawName: '', rawAddress: 'bob@example.com', position: 1 },
        { role: 'cc', rawName: 'Carol', rawAddress: 'carol@example.com', position: 2 },
        { role: 'bcc', rawName: 'Dan', rawAddress: 'dan@example.com', position: 3 },
      ],
    };
  }

  it('returns who the message was from and to, in header order', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => emailItem()) } },
      store,
    );
    const detail = await service.detail(makeAuth([TenantRole.reviewer]), ITEM_A);
    expect(detail.participants).toEqual([
      { role: 'from', name: 'Alice Smith', address: 'alice@example.com' },
      { role: 'to', name: '', address: 'bob@example.com' },
      { role: 'cc', name: 'Carol', address: 'carol@example.com' },
    ]);
  });

  it('never returns bcc addresses, only the fact that a bcc existed', async () => {
    // A recovered bcc address is not a delivered header. Showing it as one is
    // the exact claim TRUTHFULNESS_NOTICES.bcc exists to prevent.
    const { store } = makeStore();
    const { service } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => emailItem()) } },
      store,
    );
    const detail = await service.detail(makeAuth([TenantRole.reviewer]), ITEM_A);
    expect(detail.participants.map((p) => p.role)).not.toContain('bcc');
    expect(JSON.stringify(detail.participants)).not.toContain('dan@example.com');
    expect(detail.emailMetadata?.['bccPresent']).toBe(true);
  });

  it('returns an empty participant list for a file, not null', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      {
        evidenceItem: {
          findFirst: vi.fn(async () => ({
            ...emailItem(),
            kind: 'file',
            emailMetadata: null,
            participants: [],
          })),
        },
      },
      store,
    );
    const detail = await service.detail(makeAuth([TenantRole.reviewer]), ITEM_A);
    expect(detail.participants).toEqual([]);
  });
});

describe('EvidenceService.preview', () => {
  it('presigns the latest preview per kind and includes the remote-content safety note', async () => {
    const { store, presignGet } = makeStore();
    const previews = [
      {
        kind: 'safe_html',
        version: 2,
        objectKey: 'k-html-v2',
        mimeType: 'text/html',
        pageCount: 0,
      },
      {
        kind: 'safe_html',
        version: 1,
        objectKey: 'k-html-v1',
        mimeType: 'text/html',
        pageCount: 0,
      },
      { kind: 'pdf', version: 1, objectKey: 'k-pdf-v1', mimeType: 'application/pdf', pageCount: 3 },
    ];
    const { service } = makeService(
      {
        evidenceItem: { findFirst: vi.fn(async () => ({ id: ITEM_A })) },
        preview: { findMany: vi.fn(async () => previews) },
      },
      store,
    );
    const result = await service.preview(makeAuth([TenantRole.reviewer]), ITEM_A);
    expect(result.items).toHaveLength(2);
    expect(result.note).toContain('never load remote content');
    expect(presignGet).toHaveBeenCalledWith(TENANT_ID, 'k-html-v2', { ttlSeconds: 300 });
    expect(presignGet).not.toHaveBeenCalledWith(TENANT_ID, 'k-html-v1', expect.anything());
  });
});

describe('EvidenceService.auditRecords', () => {
  it('returns cursor-paginated records for an audit_batch item', async () => {
    const { store } = makeStore();
    const findFirst = vi.fn(async () => ({
      id: ITEM_A,
      name: 'o365_management_activity/Audit.Exchange/b1.json',
      sha256: 'abcd',
    }));
    const findMany = vi.fn(async () => [
      {
        id: 'rec-1',
        system: 'o365_management_activity',
        providerRecordId: 'r1',
        workload: 'Exchange',
        operation: 'MailItemsAccessed',
        recordType: '2',
        actorId: 'u1',
        actorEmail: 'alice@example.com',
        actorIp: '10.0.0.1',
        targetId: 't1',
        targetType: 'Message',
        resultStatus: 'Succeeded',
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        raw: { Id: 'r1' },
      },
    ]);
    const { service } = makeService(
      { evidenceItem: { findFirst }, auditRecord: { findMany } },
      store,
    );

    const result = await service.auditRecords(makeAuth([TenantRole.case_manager]), ITEM_A, {
      limit: 50,
    });
    // The item lookup is constrained to audit_batch kind.
    const where = findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(where.where['kind']).toBe('audit_batch');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.operation).toBe('MailItemsAccessed');
    expect(result.items[0]?.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.nextCursor).toBeNull();
    expect(result.batch.id).toBe(ITEM_A);
  });

  it('returns 404 for a non-audit or foreign id (no leakage)', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      { evidenceItem: { findFirst: vi.fn(async () => null) } },
      store,
    );
    await expect(
      service.auditRecords(makeAuth([TenantRole.case_manager]), ITEM_A, { limit: 50 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('read_only callers get 404 for audit batches outside their assigned cases', async () => {
    const { store } = makeStore();
    const caseItemCount = vi.fn(async () => 0);
    const findFirst = vi.fn(async () => ({ id: ITEM_A, name: 'b.json', sha256: 'abcd' }));
    const { service } = makeService(
      { caseItem: { count: caseItemCount }, evidenceItem: { findFirst } },
      store,
    );
    await expect(
      service.auditRecords(makeAuth([TenantRole.read_only]), ITEM_A, { limit: 50 }),
    ).rejects.toThrow(NotFoundException);
    expect(caseItemCount).toHaveBeenCalledTimes(1);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('paginates: a full page yields a nextCursor', async () => {
    const { store } = makeStore();
    const findFirst = vi.fn(async () => ({ id: ITEM_A, name: 'b.json', sha256: 'abcd' }));
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `rec-${i}`,
      system: 'google_reports',
      providerRecordId: `r${i}`,
      workload: 'login',
      operation: 'login_success',
      recordType: '',
      actorId: '',
      actorEmail: `user${i}@example.com`,
      actorIp: '',
      targetId: '',
      targetType: '',
      resultStatus: '',
      occurredAt: null,
      raw: {},
    }));
    const findMany = vi.fn(async () => rows);
    const { service } = makeService(
      { evidenceItem: { findFirst }, auditRecord: { findMany } },
      store,
    );
    const result = await service.auditRecords(makeAuth([TenantRole.case_manager]), ITEM_A, {
      limit: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('rec-1');
  });
});
