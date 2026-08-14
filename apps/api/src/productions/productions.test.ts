import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductionStatus, TenantRole } from '@aeg-clouddfir/database';
import { exceptionListResponse } from '@aeg-clouddfir/contracts';
import { ProductionsService } from './productions.service.js';
import { validateProductionSet, type ProductionValidationItem } from './production.validator.js';
import type { SelectionService } from '../search/selection.service.js';
import {
  ITEM_A,
  ITEM_B,
  TAG_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.production_manager]);
const PRODUCTION_ID = '12121212-1212-4121-8121-121212121212';
const RUN_ID = '13131313-1313-4131-8131-131313131313';

function item(overrides: Partial<ProductionValidationItem>): ProductionValidationItem {
  return {
    evidenceId: ITEM_A,
    familyId: null,
    parentId: null,
    hasFinalRedactions: false,
    hasPreviewRedactions: false,
    isPrivileged: false,
    isArchiveContainer: false,
    isDuplicate: false,
    malwareStatus: 'clean',
    hasNative: true,
    conversionSupported: true,
    processed: true,
    isEncrypted: false,
    hasText: true,
    sizeBytes: 100,
    wouldProduceNative: false,
    isCorrupt: false,
    ...overrides,
  };
}

const loadFileOutput = {
  mode: 'load_file' as const,
  imageFormat: 'tiff_g4' as const,
  includeText: true,
};

describe('validateProductionSet (flag matrix)', () => {
  it('redacted item whose native would be produced → security_critical redacted_native_leak', () => {
    const flags = validateProductionSet(
      [item({ hasFinalRedactions: true, wouldProduceNative: true })],
      { includeFamilies: false, redactionStage: 'final', output: loadFileOutput },
    );
    const leak = flags.find((flag) => flag.code === 'redacted_native_leak');
    expect(leak).toBeDefined();
    expect(leak?.severity).toBe('security_critical');
    expect(leak?.overridable).toBe(false);
    expect(leak?.requiresElevatedOverride).toBe(true);
  });

  it('preview redactions in a final release → blocking, not overridable', () => {
    const flags = validateProductionSet([item({ hasPreviewRedactions: true })], {
      includeFamilies: false,
      redactionStage: 'final',
      output: loadFileOutput,
    });
    const flag = flags.find((f) => f.code === 'preview_redactions_in_release');
    expect(flag?.severity).toBe('blocking');
    expect(flag?.overridable).toBe(false);
    // Not triggered when the stage is preview.
    const previewFlags = validateProductionSet([item({ hasPreviewRedactions: true })], {
      includeFamilies: false,
      redactionStage: 'preview',
      output: loadFileOutput,
    });
    expect(previewFlags.find((f) => f.code === 'preview_redactions_in_release')).toBeUndefined();
  });

  it('a child selected without its parent → family_split (blocking)', () => {
    const flags = validateProductionSet(
      [item({ evidenceId: ITEM_B, familyId: ITEM_A, parentId: ITEM_A })],
      { includeFamilies: true, redactionStage: 'preview', output: loadFileOutput },
    );
    const flag = flags.find((f) => f.code === 'family_split');
    expect(flag?.severity).toBe('blocking');
    expect(flag?.evidenceItemIds).toEqual([ITEM_B]);
  });

  it('infected/suspicious items → blocking malware_item; missing text only when text requested', () => {
    const flags = validateProductionSet([item({ malwareStatus: 'infected', hasText: false })], {
      includeFamilies: false,
      redactionStage: 'preview',
      output: loadFileOutput,
    });
    expect(flags.map((f) => f.code)).toContain('malware_item');
    expect(flags.map((f) => f.code)).toContain('missing_text');

    const nativesOnly = validateProductionSet([item({ hasText: false })], {
      includeFamilies: false,
      redactionStage: 'preview',
      output: { mode: 'natives_only' },
    });
    expect(nativesOnly.map((f) => f.code)).not.toContain('missing_text');
  });
});

// ---------------------------------------------------------------------------
// Submit path
// ---------------------------------------------------------------------------

function idsHash(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'), 'utf8')
    .digest('hex');
}

const parameters = {
  name: 'Prod 1',
  description: '',
  selection: {
    tagIds: [TAG_ID],
    savedSearchIds: [],
    inverted: false,
    excludePreviouslyProduced: { kind: 'none' },
    includeFamilies: false,
  },
  output: { mode: 'natives_only' },
  nativePolicy: { extensions: [], tagIds: [], subjectToSafetyOverrides: true },
  sort: 'evidence_id',
  stamps: [],
  redactions: { stage: 'final', color: '#000000', label: 'REDACTED', enforceImageOnly: true },
  bates: { prefix: 'ACME', startNumber: 1000, digits: 8, suffix: '', numbering: 'per_page' },
  filenames: 'bates',
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    calculatedAt: '2026-08-11T00:00:00.000Z',
    itemCount: 1,
    itemIdsHash: idsHash([ITEM_A]),
    flags: [] as unknown[],
    ...overrides,
  };
}

function productionRow(validation: Record<string, unknown> | null) {
  return {
    id: PRODUCTION_ID,
    tenantId: TENANT_ID,
    caseId: null,
    name: 'Prod 1',
    description: '',
    status: ProductionStatus.draft,
    draftParameters: validation ? { ...parameters, validation } : parameters,
    createdAt: new Date(),
    version: 1,
  };
}

function makeService(models: Record<string, unknown>, opts?: { store?: unknown }) {
  const audit = fakeAudit();
  const selection = { collectIdsForSavedSearch: vi.fn(async () => []) };
  const prisma = fakePrisma({
    tagAssignment: { findMany: vi.fn(async () => [{ evidenceItemId: ITEM_A }]) },
    ...models,
  });
  const service = new ProductionsService(
    prisma,
    audit.service,
    selection as unknown as SelectionService,
    (opts?.store ?? {
      listUnder: vi.fn(async () => []),
      presignGet: vi.fn(async (_t: string, key: string) => `https://signed/${key}`),
    }) as never,
    testConfig(),
  );
  return { service, audit };
}

const submitBody = {
  acknowledgedWarnings: [],
  expectedDraftCalculatedAt: '2026-08-11T00:00:00.000Z',
};

describe('ProductionsService.submit', () => {
  it('400s when blocking flags are not acknowledged', async () => {
    const snap = snapshot({
      flags: [
        {
          code: 'unprocessed_item',
          severity: 'blocking',
          overridable: true,
          requiresElevatedOverride: false,
          count: 1,
        },
      ],
    });
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(snap)) },
    });
    await expect(service.submit(auth, PRODUCTION_ID, submitBody, fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('403s when a security-critical flag lacks the second confirmation', async () => {
    const snap = snapshot({
      flags: [
        {
          code: 'redacted_native_leak',
          severity: 'security_critical',
          overridable: false,
          requiresElevatedOverride: true,
          count: 1,
        },
      ],
    });
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(snap)) },
    });
    await expect(
      service.submit(
        auth,
        PRODUCTION_ID,
        {
          ...submitBody,
          acknowledgedWarnings: [
            { code: 'redacted_native_leak', note: 'reviewed', secondConfirmation: false },
          ],
        },
        fakeRequest(),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('409s when the selection changed since the validated draft', async () => {
    const snap = snapshot({ itemIdsHash: idsHash([ITEM_A, ITEM_B]) });
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(snap)) },
    });
    let caught: ConflictException | undefined;
    try {
      await service.submit(auth, PRODUCTION_ID, submitBody, fakeRequest());
    } catch (err) {
      caught = err as ConflictException;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const response = caught?.getResponse() as { code?: string };
    expect(response.code).toBe('selection_changed_since_draft');
  });

  it('409s when the expected draftCalculatedAt is stale', async () => {
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(snapshot())) },
    });
    await expect(
      service.submit(
        auth,
        PRODUCTION_ID,
        { ...submitBody, expectedDraftCalculatedAt: '2020-01-01T00:00:00.000Z' },
        fakeRequest(),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('409s when the bates range overlaps an existing reservation for the prefix', async () => {
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(snapshot())) },
      batesReservation: {
        findFirst: vi.fn(async () => ({ startNumber: 900n, endNumber: 1200n })),
      },
    });
    let caught: ConflictException | undefined;
    try {
      await service.submit(auth, PRODUCTION_ID, submitBody, fakeRequest());
    } catch (err) {
      caught = err as ConflictException;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const response = caught?.getResponse() as { code?: string; nextFreeStart?: string };
    expect(response.code).toBe('duplicate_bates_range');
    expect(response.nextFreeStart).toBe('1201');
  });

  it('creates run + reservation + outbox atomically with frozen selection ids', async () => {
    const runCreate = vi.fn(async () => ({ id: RUN_ID }));
    const reservationCreate = vi.fn(async () => ({}));
    const outboxCreate = vi.fn(async () => ({}));
    const productionUpdate = vi.fn(async () => ({}));
    const { service, audit } = makeService({
      production: {
        findFirst: vi.fn(async () => productionRow(snapshot())),
        update: productionUpdate,
      },
      batesReservation: { findFirst: vi.fn(async () => null), create: reservationCreate },
      productionRun: {
        aggregate: vi.fn(async () => ({ _max: { runNumber: 2 } })),
        create: runCreate,
      },
      outboxEvent: { create: outboxCreate },
    });

    const result = await service.submit(auth, PRODUCTION_ID, submitBody, fakeRequest());
    expect(result.runNumber).toBe(3);
    expect(result.batesStart).toBe('ACME00001000');

    // Worker contract: frozenParameters = parameters + selectionItemIds.
    const runArgs = runCreate.mock.calls[0]?.[0] as {
      data: { frozenParameters: Record<string, unknown> };
    };
    expect(runArgs.data.frozenParameters.selectionItemIds).toEqual([ITEM_A]);
    expect(runArgs.data.frozenParameters.bates).toEqual(parameters.bates);

    const outboxArgs = outboxCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(outboxArgs.data.topic).toBe('production.run');
    expect(outboxArgs.data.dedupKey).toBe(`production-run:${RUN_ID}`);
    expect(outboxArgs.data.payload).toEqual({ tenantId: TENANT_ID, productionRunId: RUN_ID });

    expect(reservationCreate).toHaveBeenCalledTimes(1);
    expect(productionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: ProductionStatus.submitted } }),
    );
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'production.submitted' }),
    );
  });

  it('400s when submit happens before any validation', async () => {
    const { service } = makeService({
      production: { findFirst: vi.fn(async () => productionRow(null)) },
    });
    await expect(service.submit(auth, PRODUCTION_ID, submitBody, fakeRequest())).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('ProductionsService.cloneRun', () => {
  it('creates a fresh draft from a run frozen parameters', async () => {
    const createMock = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'new-prod-id',
      status: ProductionStatus.draft,
      ...args.data,
    }));
    const { service, audit } = makeService({
      productionRun: {
        findFirst: vi.fn(async () => ({
          id: RUN_ID,
          runNumber: 2,
          frozenParameters: { ...parameters, selectionItemIds: [ITEM_A] },
          production: { caseId: null, name: 'Prod 1' },
        })),
      },
      production: { create: createMock },
    });

    const result = await service.cloneRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest());
    expect(result.status).toBe(ProductionStatus.draft);

    const data = (createMock.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe(ProductionStatus.draft);
    expect(data.name).toBe('Prod 1 (run 2 copy)');
    // The frozen selection ids do NOT carry into the new draft.
    expect(JSON.stringify(data.draftParameters)).not.toContain('selectionItemIds');
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'production.cloned' }),
    );
  });
});

describe('ProductionsService.downloadRun', () => {
  const PREFIX = `tenants/${TENANT_ID}/productions/${PRODUCTION_ID}/${RUN_ID}`;

  function withRun(run: Record<string, unknown> | null, store?: unknown) {
    return makeService(
      { productionRun: { findFirst: vi.fn(async () => run) } },
      store ? { store } : undefined,
    );
  }

  const readyRun = {
    id: RUN_ID,
    status: 'ready',
    outputPrefix: PREFIX,
    manifestSha256: 'd'.repeat(64),
    runNumber: 2,
  };

  it('lists every produced file with a presigned URL, path and size', async () => {
    const store = {
      listUnder: vi.fn(async () => [
        { key: `${PREFIX}/manifests/exceptions.json`, size: 120 },
        { key: `${PREFIX}/VOL001/IMAGES/0001.tif`, size: 4096 },
      ]),
      presignGet: vi.fn(async (_t: string, key: string) => `https://signed/${key}`),
    };
    const { service, audit } = withRun(readyRun, store);

    const result = await service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest());

    // Paths are relative to the run prefix, so a recipient sees the volume
    // layout rather than tenant-scoped storage keys.
    expect(result.files.map((f) => f.path)).toEqual([
      'manifests/exceptions.json',
      'VOL001/IMAGES/0001.tif',
    ]);
    expect(result.files[1]?.sizeBytes).toBe(4096);
    expect(result.manifestSha256).toBe('d'.repeat(64));
    // A production set leaving the platform is a disclosure; it must be audited.
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'production.run_downloaded' }),
    );
  });

  it.each(['queued', 'rendering', 'stamping', 'verifying', 'failed', 'cancelled'])(
    'refuses to hand out a run in %s state',
    async (status) => {
      // Half a production set is worse than none: the recipient cannot tell.
      const { service } = withRun({ ...readyRun, status });
      await expect(
        service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest()),
      ).rejects.toThrow(ConflictException);
    },
  );

  it('allows a released run, not just a ready one', async () => {
    const store = {
      listUnder: vi.fn(async () => [{ key: `${PREFIX}/x.dat`, size: 1 }]),
      presignGet: vi.fn(async () => 'https://signed/x'),
    };
    const { service } = withRun({ ...readyRun, status: 'released' }, store);
    const result = await service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest());
    expect(result.files).toHaveLength(1);
  });

  it('reports an empty output rather than returning a plausible-looking empty set', async () => {
    // Ready in the database but nothing in storage means something is wrong;
    // an empty file list would read as a legitimately empty production.
    const store = { listUnder: vi.fn(async () => []), presignGet: vi.fn() };
    const { service } = withRun(readyRun, store);
    await expect(
      service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest()),
    ).rejects.toThrow(ConflictException);
  });

  it('404s for a run belonging to another production or tenant', async () => {
    const { service } = withRun(null);
    await expect(service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('signs a flattened attachment filename per file', async () => {
    const presignGet = vi.fn(async () => 'https://signed/x');
    const store = {
      listUnder: vi.fn(async () => [{ key: `${PREFIX}/VOL001/IMAGES/0001.tif`, size: 1 }]),
      presignGet,
    };
    const { service } = withRun(readyRun, store);
    await service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest());
    // Slashes flattened: a browser saves into one folder, so nested paths would
    // collide or be dropped entirely.
    expect(presignGet.mock.calls[0]?.[2]).toMatchObject({
      downloadFilename: 'production-run2-VOL001-IMAGES-0001.tif',
    });
  });
});


describe('ProductionsService.exceptions — matches the shared exception contract', () => {
  function excService(runs: { id: string }[], rows: Record<string, unknown>[]) {
    return makeService({
      production: { findFirst: vi.fn(async () => ({ id: PRODUCTION_ID })) },
      productionRun: { findMany: vi.fn(async () => runs) },
      productionException: { findMany: vi.fn(async () => rows) },
    }).service;
  }

  const row = {
    id: 'pe-1',
    productionRunId: RUN_ID,
    code: 'redaction_overlap',
    severity: 'warning',
    message: 'two redactions overlap on page 3',
    evidenceItemId: ITEM_A,
    overriddenAt: null,
    createdAt: new Date('2026-08-14T12:00:00.000Z'),
  };

  it('parses against exceptionListResponse, the same schema collections use', async () => {
    // The client renders both ledgers through one table, so both endpoints must
    // agree on the shape — this is the check that was missing.
    const page = await excService([{ id: RUN_ID }], [row]).exceptions(auth, PRODUCTION_ID, {
      limit: 10,
    });
    const parsed = exceptionListResponse.safeParse(page);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('maps the production code to kind and the item to itemRef', async () => {
    const page = await excService([{ id: RUN_ID }], [row]).exceptions(auth, PRODUCTION_ID, {
      limit: 10,
    });
    expect(page.items[0]).toMatchObject({
      kind: 'redaction_overlap',
      itemRef: ITEM_A,
      evidenceItemId: ITEM_A,
      severity: 'warning',
      overridden: false,
      occurredAt: '2026-08-14T12:00:00.000Z',
    });
  });

  it('reports an overridden exception as waived rather than resolved', async () => {
    const page = await excService(
      [{ id: RUN_ID }],
      [{ ...row, overriddenAt: new Date('2026-08-14T13:00:00.000Z') }],
    ).exceptions(auth, PRODUCTION_ID, { limit: 10 });
    expect(page.items[0]?.overridden).toBe(true);
  });

  it('covers every run, so an earlier unresolved problem is not hidden', async () => {
    const service = excService([{ id: RUN_ID }, { id: 'run-2' }], [row]);
    const page = await service.exceptions(auth, PRODUCTION_ID, { limit: 10 });
    expect(page.items).toHaveLength(1);
  });

  it('returns an empty page with a null cursor when there are no runs', async () => {
    const page = await excService([], []).exceptions(auth, PRODUCTION_ID, { limit: 10 });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(exceptionListResponse.safeParse(page).success).toBe(true);
  });

  it('paginates, returning a cursor only when more remain', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...row, id: `pe-${String(i)}` }));
    const page = await excService([{ id: RUN_ID }], many).exceptions(auth, PRODUCTION_ID, {
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('pe-1');
  });

  it('404s for a production in another tenant', async () => {
    const service = makeService({ production: { findFirst: vi.fn(async () => null) } }).service;
    await expect(service.exceptions(auth, PRODUCTION_ID, { limit: 10 })).rejects.toThrow(
      NotFoundException,
    );
  });
});
