import { describe, expect, it, vi } from 'vitest';
import { PRODUCTION_ID, RUN_ID, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import {
  countPdfPagesApprox,
  processProductionRun,
  type ProductionDeps,
} from './production-run.js';

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOLO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const payload = { tenantId: TENANT, productionRunId: RUN_ID };

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectionItemIds: [PARENT, CHILD, SOLO],
    name: 'Prod 1',
    description: '',
    selection: {
      tagIds: [],
      savedSearchIds: [],
      inverted: false,
      excludePreviouslyProduced: { kind: 'none' },
      includeFamilies: true,
    },
    output: {
      mode: 'load_file',
      imageFormat: 'pdf',
      includeNatives: false,
      includeText: true,
      loadFileFormats: ['dat'],
    },
    nativePolicy: { extensions: [], tagIds: [], subjectToSafetyOverrides: true },
    sort: 'evidence_id',
    stamps: [],
    redactions: { stage: 'final', color: '#000000', label: 'REDACTED', enforceImageOnly: true },
    bates: { prefix: 'ABC', startNumber: 1, digits: 6, suffix: '', numbering: 'per_document' },
    filenames: 'bates',
    ...overrides,
  };
}

interface ItemOverrides {
  redactions?: unknown[];
  extension?: string;
  childRelationships?: { parentId: string; kind: string }[];
  parentRelationships?: { childId: string; kind: string }[];
}

function item(id: string, overrides: ItemOverrides = {}): Record<string, unknown> {
  return {
    id,
    kind: 'email',
    name: `doc-${id.slice(0, 4)}`,
    extension: overrides.extension ?? '',
    mimeType: 'message/rfc822',
    size: 5n,
    sha256: '',
    sourcePath: '',
    primaryDate: null,
    sourceCreatedAt: null,
    sourceModifiedAt: null,
    blob: null,
    custodian: { email: 'user@example.com' },
    emailMetadata: {
      subject: 'subject',
      bodyPlain: 'body text',
      bccPresent: false,
      sentAt: null,
      receivedAt: null,
    },
    participants: [],
    extractedTexts: [],
    redactions: overrides.redactions ?? [],
    tagAssignments: [],
    childRelationships: overrides.childRelationships ?? [],
    parentRelationships: overrides.parentRelationships ?? [],
  };
}

function deps(overrides: Partial<ProductionDeps> = {}): Partial<ProductionDeps> {
  return {
    renderPlaceholder: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    stamp: vi.fn(async (pdf: Uint8Array) => ({ pdfBytes: pdf, droppedStamps: [] })),
    validateNoTextLayer: vi.fn().mockResolvedValue({ hasText: false, pagesWithText: [] }),
    assembleImagePdf: vi.fn().mockResolvedValue(new Uint8Array([9])),
    buildManifest: vi.fn().mockReturnValue({ json: '{"schema":"test"}', sha256: 'm'.repeat(64) }),
    rasterizerAvailable: () => Promise.resolve(false),
    ...overrides,
  };
}

function arm(f: FakeCtx, frozen: Record<string, unknown>, items: Record<string, unknown>[]): void {
  f.tx.productionRun.findUnique.mockResolvedValue({
    id: RUN_ID,
    productionId: PRODUCTION_ID,
    status: 'queued',
    startedAt: null,
    frozenParameters: frozen,
    production: { id: PRODUCTION_ID },
    batesReservations: [
      { id: 'br-1', prefix: 'ABC', suffix: '', digits: 6, startNumber: 1n, endNumber: 1000n },
    ],
  });
  f.tx.evidenceItem.findMany.mockResolvedValue(items);
}

function createdProductionItems(f: FakeCtx): Record<string, unknown>[] {
  return f.tx.productionItem.createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Record<string, unknown>[] }).data,
  );
}

function createdExceptions(f: FakeCtx): Record<string, unknown>[] {
  return f.tx.productionException.createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Record<string, unknown>[] }).data,
  );
}

describe('processProductionRun', () => {
  it('assigns contiguous bates across sorted families and stamps attachment ranges', async () => {
    const f = fakeCtx();
    arm(f, params(), [
      item(SOLO),
      item(CHILD, { childRelationships: [{ parentId: PARENT, kind: 'attachment' }] }),
      item(PARENT, { parentRelationships: [{ childId: CHILD, kind: 'attachment' }] }),
    ]);

    await processProductionRun(f.ctx, payload, deps());

    const rows = createdProductionItems(f);
    expect(rows.map((r) => r['evidenceItemId'])).toEqual([PARENT, CHILD, SOLO]);
    expect(rows.map((r) => r['begBates'])).toEqual(['ABC000001', 'ABC000002', 'ABC000003']);
    // Family adjacency: parent + child share the attachment range; solo has none.
    expect(rows[0]).toMatchObject({ begAttach: 'ABC000001', endAttach: 'ABC000002' });
    expect(rows[1]).toMatchObject({ begAttach: 'ABC000001', endAttach: 'ABC000002' });
    expect(rows[2]).toMatchObject({ begAttach: '', endAttach: '' });

    const finalUpdate = f.tx.productionRun.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data).toMatchObject({
      status: 'ready',
      batesStart: 'ABC000001',
      batesEnd: 'ABC000003',
      manifestSha256: 'm'.repeat(64),
    });
  });

  it('a redacted item requesting native output ships a placeholder + security exception', async () => {
    const f = fakeCtx();
    arm(
      f,
      params({
        output: {
          mode: 'load_file',
          imageFormat: 'pdf',
          includeNatives: true,
          includeText: true,
          loadFileFormats: ['dat'],
        },
        nativePolicy: { extensions: ['txt'], tagIds: [], subjectToSafetyOverrides: true },
        selectionItemIds: [SOLO],
      }),
      [item(SOLO, { extension: 'txt', redactions: [{ id: 'r1', stage: 'final' }] })],
    );

    await processProductionRun(f.ctx, payload, deps());

    const exceptions = createdExceptions(f);
    const security = exceptions.filter(
      (e) => e['code'] === 'redacted_native_leak' && e['severity'] === 'security_critical',
    );
    expect(security.length).toBeGreaterThanOrEqual(1);

    const rows = createdProductionItems(f);
    expect(rows[0]).toMatchObject({
      outputKind: 'placeholder',
      state: 'placeholder',
      nativePath: '',
    });
    // The run still completes; item-level problems never fail the run.
    const finalUpdate = f.tx.productionRun.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('ready');
  });

  it('records an honest downgrade exception when tiff_g4 is requested without a rasterizer', async () => {
    const f = fakeCtx();
    arm(
      f,
      params({
        output: {
          mode: 'load_file',
          imageFormat: 'tiff_g4',
          includeNatives: false,
          includeText: true,
          loadFileFormats: ['dat'],
        },
        selectionItemIds: [SOLO],
      }),
      [item(SOLO)],
    );

    await processProductionRun(f.ctx, payload, deps());

    const downgrade = createdExceptions(f).find((e) => e['code'] === 'unsupported_conversion');
    expect(String(downgrade?.['message'])).toContain('downgraded');
    expect(String(downgrade?.['message'])).toContain('tiff_g4');
  });

  it('a redacted rendering that fails the no-text-layer gate becomes a placeholder', async () => {
    const f = fakeCtx();
    arm(f, params({ selectionItemIds: [SOLO] }), [
      item(SOLO, { redactions: [{ id: 'r1', stage: 'final' }] }),
    ]);
    const gate = vi.fn().mockResolvedValue({ hasText: true, pagesWithText: [1] });

    await processProductionRun(
      f.ctx,
      payload,
      deps({ rasterizerAvailable: () => Promise.resolve(true), validateNoTextLayer: gate }),
    );

    expect(gate).toHaveBeenCalled();
    const rows = createdProductionItems(f);
    expect(rows[0]).toMatchObject({ outputKind: 'placeholder', state: 'placeholder' });
    const security = createdExceptions(f).filter((e) => e['severity'] === 'security_critical');
    expect(security.length).toBeGreaterThanOrEqual(1);
  });

  it('fails the run record on malformed frozen parameters', async () => {
    const f = fakeCtx();
    arm(f, { nonsense: true }, []);
    await expect(processProductionRun(f.ctx, payload, deps())).resolves.toBeUndefined();
    const finalUpdate = f.tx.productionRun.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('failed');
  });
});

describe('countPdfPagesApprox', () => {
  it('counts /Type /Page markers with a floor of one', () => {
    const pdf = Buffer.from('%PDF-1.4 /Type /Page x /Type /Pages y /Type /Page z');
    expect(countPdfPagesApprox(pdf)).toBe(2);
    expect(countPdfPagesApprox(Buffer.from('garbage'))).toBe(1);
  });
});
