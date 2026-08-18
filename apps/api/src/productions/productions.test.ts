import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProductionStatus, TenantRole } from '@aeg-clouddfir/database';
import {
  exceptionListResponse,
  productionDetail,
  productionRunStatusResponse,
} from '@aeg-clouddfir/contracts';
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
const RUN_ID_2 = '14141414-1414-4141-8141-141414141414';

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
      await expect(service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest())).rejects.toThrow(
        ConflictException,
      );
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
    await expect(service.downloadRun(auth, PRODUCTION_ID, RUN_ID, fakeRequest())).rejects.toThrow(
      ConflictException,
    );
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

// ---------------------------------------------------------------------------
// Archive (single-file) download
// ---------------------------------------------------------------------------

/**
 * The per-file endpoint above hands back one presigned URL per object, so
 * downloading a production meant clicking every file and rebuilding the volume
 * layout by hand. These cover the archive route: one request, one file, and
 * extracting it reproduces the folder tree the run wrote.
 */
describe('ProductionsService run archive', () => {
  const PREFIX = `tenants/${TENANT_ID}/productions/${PRODUCTION_ID}/${RUN_ID}`;

  const readyRun = {
    id: RUN_ID,
    status: 'ready',
    outputPrefix: PREFIX,
    manifestSha256: 'd'.repeat(64),
    runNumber: 2,
    production: { name: 'Acme v Widgets' },
  };

  const OBJECTS = [
    { key: `${PREFIX}/MANIFESTS/manifest.json`, size: 120 },
    { key: `${PREFIX}/DATA/loadfile.dat`, size: 64 },
    { key: `${PREFIX}/IMAGES/VOL001/PROD00000001.tif`, size: 4096 },
  ];

  function withRun(run: Record<string, unknown> | null, store?: Record<string, unknown>) {
    return makeService(
      { productionRun: { findFirst: vi.fn(async () => run) } },
      {
        store: {
          listUnder: vi.fn(async () => OBJECTS),
          getStream: vi.fn(async (_c: string, key: string) => Readable.from([`bytes:${key}`])),
          ...store,
        },
      },
    );
  }

  /** Records what would be written, so per-entry wiring can be asserted. */
  function fakeArchive() {
    const appended: string[] = [];
    const state = { finalized: false };
    return {
      appended,
      state,
      create: () => ({
        append: (path: string) => {
          appended.push(path);
        },
        finalize: async () => {
          state.finalized = true;
          return { entryCount: appended.length };
        },
      }),
    };
  }

  describe('prepareRunArchive', () => {
    it('names the file and the folder inside it after the production and run', async () => {
      const { service } = withRun(readyRun);
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      // A zip whose entries sit at the root scatters files into whatever
      // directory the recipient extracted from; one top-level folder is what
      // makes this "download the production into a folder".
      expect(plan.rootFolder).toBe('acme-v-widgets-run2');
      expect(plan.fileName).toBe('acme-v-widgets-run2.zip');
      expect(plan.manifestSha256).toBe('d'.repeat(64));
      expect(plan.objects).toHaveLength(3);
      expect(plan.totalBytes).toBe(120 + 64 + 4096);
    });

    it.each([
      ['../../etc', 'etc-run2'],
      ['A/B\\C', 'a-b-c-run2'],
      ['   ', 'production-run2'],
      ['Ünïcodé name', 'unicode-name-run2'],
    ])('sanitises the production name %s into %s', async (name, expected) => {
      // The name reaches a Content-Disposition header and every entry path, so
      // separators and traversal must not survive it.
      const { service } = withRun({ ...readyRun, production: { name } });
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      expect(plan.rootFolder).toBe(expected);
      expect(plan.rootFolder).not.toContain('/');
      expect(plan.rootFolder).not.toContain('..');
    });

    it('404s for a run belonging to another production or tenant', async () => {
      const { service } = withRun(null);
      await expect(service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['queued', 'rendering', 'failed', 'cancelled'])(
      'refuses a run in %s state before a single byte is sent',
      async (status) => {
        // Validation must happen while a JSON error can still be returned: once
        // the zip body starts, the client can only be told by a broken stream.
        const { service } = withRun({ ...readyRun, status });
        await expect(service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID)).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it('refuses when storage holds nothing for the run', async () => {
      const { service } = withRun(readyRun, { listUnder: vi.fn(async () => []) });
      await expect(service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('streamRunArchive', () => {
    it('writes every object under the run folder, keeping the volume layout', async () => {
      const { service } = withRun(readyRun);
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      const archive = fakeArchive();

      const result = await service.streamRunArchive(auth, plan, new PassThrough(), fakeRequest(), {
        createArchive: archive.create,
      });

      expect(archive.appended).toEqual([
        'acme-v-widgets-run2/MANIFESTS/manifest.json',
        'acme-v-widgets-run2/DATA/loadfile.dat',
        'acme-v-widgets-run2/IMAGES/VOL001/PROD00000001.tif',
      ]);
      expect(result.entryCount).toBe(3);
      expect(archive.state.finalized).toBe(true);
    });

    it('audits the download, because a production leaving the platform is a disclosure', async () => {
      const { service, audit } = withRun(readyRun);
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      await service.streamRunArchive(auth, plan, new PassThrough(), fakeRequest(), {
        createArchive: fakeArchive().create,
      });
      expect(audit.appendTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'production.run_downloaded' }),
      );
    });

    it('cannot produce a valid archive when an object fails to read', async () => {
      // A finalized zip is a VALID zip. If a read failed and the archive still
      // finalized, the recipient would get a well-formed archive silently
      // missing documents — the worst outcome for a disclosure. Uses the real
      // writer, because "no end-of-central-directory record" is a fact about
      // bytes that a fake archive cannot establish.
      const { service } = withRun(readyRun, {
        getStream: vi.fn(async (_c: string, key: string) => {
          if (key.endsWith('.tif')) throw new Error('storage read failed');
          return Readable.from(['ok']);
        }),
      });
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on('data', (c: Buffer) => chunks.push(c));

      await expect(service.streamRunArchive(auth, plan, sink, fakeRequest())).rejects.toThrow(
        /storage read failed/,
      );
      // No end-of-central-directory record: unzip refuses the file outright.
      expect(Buffer.concat(chunks).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
    });

    it('opens each object only when the archive reaches it', async () => {
      // Awaiting every GetObject up front would hold one open connection per
      // file for the whole archive — thousands, on a real production, most
      // idling long enough to time out.
      const getStream = vi.fn(async () => Readable.from(['ok']));
      const { service } = withRun(readyRun, { getStream });
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);

      await service.streamRunArchive(auth, plan, new PassThrough(), fakeRequest(), {
        createArchive: fakeArchive().create,
      });

      // The fake archive never reads its sources, so nothing should have opened.
      expect(getStream).not.toHaveBeenCalled();
    });

    it('produces a real, structurally complete zip', async () => {
      // The fake archive proves the wiring; only the real writer proves the
      // bytes. Entry names must appear and the end-of-central-directory record
      // must be present — a truncated stream has neither.
      const getStream = vi.fn(async (_c: string, key: string) => Readable.from([`bytes:${key}`]));
      const { service } = withRun(readyRun, { getStream });
      const plan = await service.prepareRunArchive(auth, PRODUCTION_ID, RUN_ID);
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on('data', (c: Buffer) => chunks.push(c));

      await service.streamRunArchive(auth, plan, sink, fakeRequest());
      const bytes = Buffer.concat(chunks);

      // Read from the evidence bucket, by full storage key.
      expect(getStream).toHaveBeenCalledWith('evidence', `${PREFIX}/DATA/loadfile.dat`);
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(bytes.includes('acme-v-widgets-run2/DATA/loadfile.dat')).toBe(true);
      expect(bytes.includes('acme-v-widgets-run2/IMAGES/VOL001/PROD00000001.tif')).toBe(true);
      // PK\x05\x06 is written only by a successful finalize.
      expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
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

/**
 * The detail page validates GET /productions/:id with productionDetail, whose
 * runs use productionRunStatusResponse. get() returned only id/runNumber/status
 * — three of nine fields — and omitted `parameters` entirely, so the page failed
 * with six validation errors while both sides compiled.
 */
describe('ProductionsService.get — matches productionDetail', () => {
  // Reuse the submit-path fixture rather than inventing a second shape: it is a
  // complete productionParameters, which is what create/update store, so it is
  // what a real draftParameters column holds.
  const params = parameters;

  function detailService(runs: Record<string, unknown>[], groups: unknown[] = []) {
    return makeService({
      production: {
        findFirst: vi.fn(async () => ({
          id: PRODUCTION_ID,
          name: 'Production 1',
          description: 'desc',
          status: 'draft',
          caseId: null,
          createdAt: new Date('2026-08-14T12:00:00.000Z'),
          version: 1,
          draftParameters: params,
          runs,
        })),
      },
      productionException: { groupBy: vi.fn(async () => groups) },
    }).service;
  }

  const runRow = {
    id: RUN_ID,
    runNumber: 1,
    status: 'ready',
    progress: { rendered: 5, stamped: 5 },
    batesStart: 'ABC000001',
    batesEnd: 'ABC000005',
    manifestSha256: 'f'.repeat(64),
  };

  it('parses against productionDetail, runs included', async () => {
    const detail = await detailService(
      [runRow],
      [{ productionRunId: RUN_ID, code: 'redaction_overlap', _count: { _all: 2 } }],
    ).get(auth, PRODUCTION_ID);

    const parsed = productionDetail.safeParse(detail);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('exposes parameters under the name the client reads', async () => {
    const detail = await detailService([runRow]).get(auth, PRODUCTION_ID);
    // The column is draftParameters; the contract field is parameters.
    expect(detail.parameters).toEqual(params);
  });

  it('returns every run field, with exception counts attributed to the right run', async () => {
    const second = { ...runRow, id: RUN_ID_2, runNumber: 2, status: 'queued' };
    const detail = await detailService(
      [runRow, second],
      [
        { productionRunId: RUN_ID, code: 'redaction_overlap', _count: { _all: 2 } },
        { productionRunId: RUN_ID_2, code: 'missing_native', _count: { _all: 1 } },
      ],
    ).get(auth, PRODUCTION_ID);

    expect(detail.runs[0]).toMatchObject({
      batesStart: 'ABC000001',
      batesEnd: 'ABC000005',
      manifestSha256: 'f'.repeat(64),
      progress: { rendered: 5, stamped: 5 },
      exceptionCounts: { redaction_overlap: 2 },
    });
    // Counts must not bleed between runs.
    expect(detail.runs[1]?.exceptionCounts).toEqual({ missing_native: 1 });
    expect(productionRunStatusResponse.safeParse(detail.runs[1]).success).toBe(true);
  });

  it('drops non-numeric progress entries rather than failing the contract', async () => {
    // progress is JSONB and can hold anything a previous version wrote.
    const detail = await detailService([
      { ...runRow, progress: { rendered: 5, note: 'partial', nested: { a: 1 } } },
    ]).get(auth, PRODUCTION_ID);
    expect(detail.runs[0]?.progress).toEqual({ rendered: 5 });
    expect(productionDetail.safeParse(detail).success).toBe(true);
  });

  it('handles a production with no runs, and skips the exception query', async () => {
    const groupBy = vi.fn(async () => []);
    const service = makeService({
      production: {
        findFirst: vi.fn(async () => ({
          id: PRODUCTION_ID,
          name: 'p',
          description: '',
          status: 'draft',
          caseId: null,
          createdAt: new Date('2026-08-14T12:00:00.000Z'),
          version: 1,
          draftParameters: params,
          runs: [],
        })),
      },
      productionException: { groupBy },
    }).service;
    const detail = await service.get(auth, PRODUCTION_ID);
    expect(detail.runs).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
    expect(productionDetail.safeParse(detail).success).toBe(true);
  });

  it('404s for a production in another tenant', async () => {
    const service = makeService({
      production: { findFirst: vi.fn(async () => null) },
    }).service;
    await expect(service.get(auth, PRODUCTION_ID)).rejects.toThrow(NotFoundException);
  });
});
