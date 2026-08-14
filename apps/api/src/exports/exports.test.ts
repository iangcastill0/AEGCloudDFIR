import { describe, expect, it, vi } from 'vitest';
import { ConflictException, GoneException } from '@nestjs/common';
import { ExportStatus, TenantRole } from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import { Readable } from 'node:stream';
import { exportStatusResponse } from '@aeg-clouddfir/contracts';
import { ExportsService } from './exports.service.js';
import type { SelectionService } from '../search/selection.service.js';
import {
  ITEM_A,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.case_manager]);
const EXPORT_ID = '14141414-1414-4141-8141-141414141414';

function makeStore(manifestJson?: unknown) {
  const presignGet = vi.fn(async (_tenant: string, key: string) => `https://signed/${key}`);
  const getStream = vi.fn(async () => {
    if (manifestJson === undefined) throw new Error('no manifest');
    return Readable.from([Buffer.from(JSON.stringify(manifestJson), 'utf8')]);
  });
  return {
    store: { presignGet, getStream } as unknown as EvidenceObjectStore,
    presignGet,
  };
}

function makeService(models: Record<string, unknown>, store: EvidenceObjectStore) {
  const audit = fakeAudit();
  const selection = { countForSavedSearch: vi.fn(async () => 5) };
  const service = new ExportsService(
    fakePrisma(models),
    testConfig(),
    store,
    audit.service,
    selection as unknown as SelectionService,
  );
  return { service, audit };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    tenantId: TENANT_ID,
    kind: 'native',
    name: 'Export 1',
    status: ExportStatus.ready,
    statusDetail: '',
    itemCount: 3,
    totalBytes: 1024n,
    manifestSha256: 'abc123',
    verifiedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

describe('ExportsService.create', () => {
  it('freezes EXACTLY the worker-contract parameter subset and enqueues export.run', async () => {
    // Returns a full row: create() maps it through toDto, because the client
    // validates this response with the same schema it uses for GET.
    const exportCreate = vi.fn(async () => exportRow({ status: ExportStatus.queued }));
    const outboxCreate = vi.fn(async () => ({}));
    const { store } = makeStore();
    const { service, audit } = makeService(
      {
        export: {
          findFirst: vi.fn(async () => null),
          count: vi.fn(async () => 0),
          create: exportCreate,
        },
        evidenceItem: { count: vi.fn(async () => 1) },
        tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
        outboxEvent: { create: outboxCreate },
      },
      store,
    );

    await service.create(
      auth,
      {
        idempotencyKey: 'idem-export-1',
        kind: 'native',
        name: 'Export 1',
        selection: { kind: 'items', evidenceItemIds: [ITEM_A] },
        includeFamilies: true,
        archiveSplitMb: 2048,
      },
      fakeRequest(),
    );

    const created = exportCreate.mock.calls[0]?.[0] as { data: { parameters: unknown } };
    expect(created.data.parameters).toEqual({
      selection: { kind: 'items', evidenceItemIds: [ITEM_A] },
      includeFamilies: true,
      archiveSplitMb: 2048,
    });

    const outboxArgs = outboxCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(outboxArgs.data.topic).toBe('export.run');
    expect(outboxArgs.data.dedupKey).toBe(`export:${EXPORT_ID}`);
    expect(outboxArgs.data.payload).toEqual({ tenantId: TENANT_ID, exportId: EXPORT_ID });

    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'export.created' }),
    );
  });
});

/**
 * The web client validates the POST /exports response with the SAME schema it
 * uses for GET. When create() returned a narrower shape, Zod rejected it with
 * six "expected string, received undefined" errors and the export never
 * appeared in the UI — even though it had been created successfully. Asserting
 * the response against the client's own contract is what catches that.
 */
describe('ExportsService.create — response satisfies the client contract', () => {
  function serviceReturning(existing: unknown, created: unknown) {
    const { store } = makeStore();
    return makeService(
      {
        export: {
          findFirst: vi.fn(async () => existing),
          count: vi.fn(async () => 0),
          create: vi.fn(async () => created),
        },
        evidenceItem: { count: vi.fn(async () => 1) },
        tenant: { findUnique: vi.fn(async () => ({ id: TENANT_ID, planQuota: {} })) },
        outboxEvent: { create: vi.fn(async () => ({})) },
      },
      store,
    ).service;
  }

  const input = {
    idempotencyKey: 'idem-contract-1',
    kind: 'native' as const,
    name: 'Export 1',
    selection: { kind: 'items' as const, evidenceItemIds: [ITEM_A] },
    includeFamilies: true,
    archiveSplitMb: 2048,
  };

  it('a newly created export parses against exportStatusResponse', async () => {
    const service = serviceReturning(null, exportRow({ status: ExportStatus.queued }));
    const result = await service.create(auth, input, fakeRequest());

    const parsed = exportStatusResponse.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(result.replayed).toBe(false);
  });

  it('a replayed (idempotent) export also parses, and is flagged as replayed', async () => {
    // The idempotency path previously returned only id/status/itemCount.
    const service = serviceReturning(exportRow({ status: ExportStatus.running }), null);
    const result = await service.create(auth, input, fakeRequest());

    const parsed = exportStatusResponse.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(result.replayed).toBe(true);
  });

  it('serialises bigint totalBytes as a string and dates as ISO or null', async () => {
    const verifiedAt = new Date('2026-08-14T00:00:00.000Z');
    const service = serviceReturning(
      null,
      exportRow({ totalBytes: 9007199254740993n, verifiedAt, expiresAt: null }),
    );
    const result = await service.create(auth, input, fakeRequest());

    // Beyond Number.MAX_SAFE_INTEGER: a number here would silently lose precision.
    expect(result.totalBytes).toBe('9007199254740993');
    expect(result.verifiedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(result.downloadExpiresAt).toBeNull();
    expect(exportStatusResponse.safeParse(result).success).toBe(true);
  });
});

describe('ExportsService.download', () => {
  it('refuses with 409 while the export is not ready', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      { export: { findFirst: vi.fn(async () => exportRow({ status: ExportStatus.running })) } },
      store,
    );
    await expect(service.download(auth, EXPORT_ID, fakeRequest())).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuses with 410 after the download window expired', async () => {
    const { store } = makeStore();
    const { service } = makeService(
      {
        export: {
          findFirst: vi.fn(async () => exportRow({ expiresAt: new Date(Date.now() - 60_000) })),
        },
      },
      store,
    );
    await expect(service.download(auth, EXPORT_ID, fakeRequest())).rejects.toThrow(GoneException);
  });

  it('presigns manifest + every archive part and audits the download', async () => {
    const manifest = { items: [{ archivePart: 1 }, { archivePart: 2 }] };
    const { store, presignGet } = makeStore(manifest);
    const { service, audit } = makeService(
      { export: { findFirst: vi.fn(async () => exportRow()) } },
      store,
    );

    const result = await service.download(auth, EXPORT_ID, fakeRequest());
    expect(result.manifestSha256).toBe('abc123');
    expect(result.archiveUrls).toHaveLength(2);
    expect(result.archiveUrls[0]).toContain('export-part001.zip');
    expect(result.archiveUrls[1]).toContain('export-part002.zip');
    expect(result.manifestUrl).toContain('manifest.json');
    expect(presignGet).toHaveBeenCalledTimes(3);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'export.downloaded',
        targetId: EXPORT_ID,
        summary: expect.objectContaining({ archiveParts: 2 }),
      }),
    );
    // Presigned URLs never enter the audit trail.
    const summary = (audit.append.mock.calls[0]?.[0] as { summary: unknown }).summary;
    expect(JSON.stringify(summary)).not.toContain('https://signed');
  });
});
