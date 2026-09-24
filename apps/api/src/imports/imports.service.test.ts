import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import { ImportsService } from './imports.service.js';
import {
  CASE_ID,
  ITEM_A,
  MEMBERSHIP_ID,
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

  it('searches only one authorized import and returns a bounded content snippet', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const importFindFirst = vi.fn().mockResolvedValue({
      id: importId,
      createdById: USER_ID,
      cases: [],
    });
    const artifactFindMany = vi.fn().mockResolvedValue([
      {
        id: ITEM_A,
        parentId: null,
        evidenceItemId: ITEM_A,
        path: 'logs/auth.log',
        name: 'auth.log',
        kind: 'file',
        mimeType: 'text/plain',
        size: 200n,
        sha256: 'a'.repeat(64),
        viewerType: 'log',
        metadata: {},
        textIndex: `prefix ${'x'.repeat(150)} user login succeeded ${'y'.repeat(200)}`,
      },
    ]);
    const prisma = fakePrisma({
      forensicImport: { findFirst: importFindFirst },
      importArtifact: { findMany: artifactFindMany },
    });
    const service = new ImportsService(prisma, store() as never, fakeAudit().service);

    const result = await service.search(makeAuth([TenantRole.case_manager]), importId, {
      q: 'login',
      limit: 50,
    });

    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_ID,
          importId,
          OR: expect.arrayContaining([{ textIndex: { contains: 'login', mode: 'insensitive' } }]),
        }),
      }),
    );
    expect(result.items[0]?.matchLocation).toBe('content');
    expect(result.items[0]?.snippet).toContain('login');
    expect(result.items[0]?.snippet.length).toBeLessThanOrEqual(400);
    expect(importFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      artifactFindMany.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('labels filename and path matches before content matches', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const base = {
      parentId: null,
      evidenceItemId: ITEM_A,
      kind: 'file',
      mimeType: 'application/json',
      size: 10n,
      sha256: 'a'.repeat(64),
      viewerType: 'tree_text',
      metadata: {},
      textIndex: 'content does not contain either search',
    };
    const artifactFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ ...base, id: ITEM_A, name: 'login.json', path: 'data/login.json' }])
      .mockResolvedValueOnce([
        {
          ...base,
          id: '66666666-6666-4666-8666-666666666666',
          name: 'events.json',
          path: 'archives/security/events.json',
        },
      ]);
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: importId,
          createdById: USER_ID,
          cases: [],
        }),
      },
      importArtifact: { findMany: artifactFindMany },
    });
    const service = new ImportsService(prisma, store() as never, fakeAudit().service);
    const auth = makeAuth([TenantRole.case_manager]);

    expect(
      (await service.search(auth, importId, { q: 'login', limit: 50 })).items[0],
    ).toMatchObject({ matchLocation: 'name', snippet: 'login.json' });
    expect(
      (await service.search(auth, importId, { q: 'security', limit: 50 })).items[0],
    ).toMatchObject({
      matchLocation: 'path',
      snippet: 'archives/security/events.json',
    });
  });

  it('treats SQL wildcard characters literally and centers long snippets on the match', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const artifactFindMany = vi.fn().mockResolvedValue([
      {
        id: ITEM_A,
        parentId: null,
        evidenceItemId: ITEM_A,
        path: 'logs/long.log',
        name: `${'x'.repeat(450)}100%_done.log`,
        kind: 'file',
        mimeType: 'text/plain',
        size: 10n,
        sha256: 'a'.repeat(64),
        viewerType: 'log',
        metadata: {},
        textIndex: '',
      },
    ]);
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: importId,
          createdById: USER_ID,
          cases: [],
        }),
      },
      importArtifact: { findMany: artifactFindMany },
    });
    const service = new ImportsService(prisma, store() as never, fakeAudit().service);

    const result = await service.search(makeAuth([TenantRole.case_manager]), importId, {
      q: '100%_done',
      limit: 50,
    });

    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { name: { contains: '100\\%\\_done', mode: 'insensitive' } },
          ]),
        }),
      }),
    );
    expect(result.items[0]?.snippet).toContain('100%_done');
    expect(result.items[0]?.snippet.length).toBeLessThanOrEqual(400);
  });

  it('uses an id cursor and returns the next cursor when more matches exist', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const cursor = '77777777-7777-4777-8777-777777777777';
    const rows = [ITEM_A, '66666666-6666-4666-8666-666666666666'].map((id) => ({
      id,
      parentId: null,
      evidenceItemId: id,
      path: `${id}.log`,
      name: `${id}.log`,
      kind: 'file',
      mimeType: 'text/plain',
      size: 10n,
      sha256: 'a'.repeat(64),
      viewerType: 'log',
      metadata: {},
      textIndex: 'login',
    }));
    const artifactFindMany = vi.fn().mockResolvedValue(rows);
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: importId,
          createdById: USER_ID,
          cases: [],
        }),
      },
      importArtifact: { findMany: artifactFindMany },
    });
    const service = new ImportsService(prisma, store() as never, fakeAudit().service);

    const result = await service.search(makeAuth([TenantRole.case_manager]), importId, {
      q: 'login',
      limit: 1,
      cursor,
    });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe(ITEM_A);
    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: cursor }, skip: 1, take: 2 }),
    );
  });

  it('allows an org admin and an assigned case member to search', async () => {
    const importId = '99999999-9999-4999-8999-999999999999';
    const artifactFindMany = vi.fn().mockResolvedValue([]);
    const orgAdminService = new ImportsService(
      fakePrisma({
        forensicImport: {
          findFirst: vi.fn().mockResolvedValue({
            id: importId,
            createdById: '88888888-8888-4888-8888-888888888888',
            cases: [],
          }),
        },
        importArtifact: { findMany: artifactFindMany },
      }),
      store() as never,
      fakeAudit().service,
    );
    await expect(
      orgAdminService.search(makeAuth([TenantRole.org_admin]), importId, {
        q: 'login',
        limit: 50,
      }),
    ).resolves.toBeTruthy();

    const memberService = new ImportsService(
      fakePrisma({
        forensicImport: {
          findFirst: vi.fn().mockResolvedValue({
            id: importId,
            createdById: '88888888-8888-4888-8888-888888888888',
            cases: [
              {
                caseId: CASE_ID,
                case: { members: [{ membershipId: MEMBERSHIP_ID }] },
              },
            ],
          }),
        },
        importArtifact: { findMany: vi.fn().mockResolvedValue([]) },
      }),
      store() as never,
      fakeAudit().service,
    );
    await expect(
      memberService.search(makeAuth([TenantRole.read_only]), importId, {
        q: 'login',
        limit: 50,
      }),
    ).resolves.toBeTruthy();
  });

  it('does not search an import the caller cannot read', async () => {
    const artifactFindMany = vi.fn();
    const prisma = fakePrisma({
      forensicImport: {
        findFirst: vi.fn().mockResolvedValue({
          id: '99999999-9999-4999-8999-999999999999',
          createdById: '88888888-8888-4888-8888-888888888888',
          cases: [],
        }),
      },
      importArtifact: { findMany: artifactFindMany },
    });
    const service = new ImportsService(prisma, store() as never, fakeAudit().service);

    await expect(
      service.search(makeAuth([TenantRole.case_manager]), '99999999-9999-4999-8999-999999999999', {
        q: 'login',
        limit: 50,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(artifactFindMany).not.toHaveBeenCalled();
  });
});
