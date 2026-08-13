import { describe, expect, it } from 'vitest';
import {
  collectionScope,
  completeness,
  createCollectionRequest,
  createExportRequest,
  productionParameters,
  timezoneId,
  TRUTHFULNESS_NOTICES,
} from './index.js';

const validScope = {
  dateRange: {
    kind: 'range',
    startDate: '2024-01-01',
    endDate: '2024-06-30',
    timezone: 'America/Chicago',
  },
  email: {
    folderIds: null,
    includeSpam: true,
    includeTrash: false,
    includeRecoverableItems: false,
  },
};

describe('collection contracts', () => {
  it('accepts a valid ranged scope with explicit timezone', () => {
    expect(collectionScope.parse(validScope).dateRange.kind).toBe('range');
  });

  it('rejects invalid timezone identifiers', () => {
    expect(timezoneId.safeParse('America/Chicago').success).toBe(true);
    expect(timezoneId.safeParse('Not/AZone').success).toBe(false);
    expect(
      collectionScope.safeParse({
        ...validScope,
        dateRange: { ...validScope.dateRange, timezone: 'PST' },
      }).success,
    ).toBe(false);
  });

  it('requires idempotency key, custodians and at least one source', () => {
    const base = {
      idempotencyKey: 'client-key-123',
      connectorAccountId: '11111111-1111-4111-8111-111111111111',
      name: 'Q1 snapshot',
      sources: ['email'],
      custodianIds: ['22222222-2222-4222-8222-222222222222'],
      scope: { dateRange: { kind: 'all_time' } },
    };
    expect(createCollectionRequest.parse(base).kind).toBe('snapshot');
    expect(createCollectionRequest.safeParse({ ...base, sources: [] }).success).toBe(false);
    expect(createCollectionRequest.safeParse({ ...base, custodianIds: [] }).success).toBe(false);
    expect(createCollectionRequest.safeParse({ ...base, idempotencyKey: 'x' }).success).toBe(false);
  });

  it('completeness vocabulary excludes unqualified values', () => {
    expect(completeness.safeParse('complete').success).toBe(false);
    expect(completeness.safeParse('all data').success).toBe(false);
    expect(completeness.safeParse('complete_within_selected_api_scope').success).toBe(true);
  });

  it('upload scope requires a non-empty evidenceItemIds list', () => {
    const base = { dateRange: { kind: 'all_time' } };
    expect(collectionScope.safeParse({ ...base, uploads: { evidenceItemIds: [] } }).success).toBe(
      false,
    );
    expect(
      collectionScope.safeParse({
        ...base,
        uploads: { evidenceItemIds: ['55555555-5555-4555-8555-555555555555'] },
      }).success,
    ).toBe(true);
  });

  it('upload collections require exactly one of custodianIds / uploadCustodian', () => {
    const uploadBase = {
      idempotencyKey: 'client-key-upload-1',
      name: 'PST intake',
      sources: ['email'],
      custodianIds: [],
      scope: {
        dateRange: { kind: 'all_time' },
        uploads: { evidenceItemIds: ['55555555-5555-4555-8555-555555555555'] },
      },
    };
    const custodian = { email: 'jane@example.com', displayName: 'Jane' };
    // neither
    expect(createCollectionRequest.safeParse(uploadBase).success).toBe(false);
    // exactly one (uploadCustodian) — connectorAccountId is resolved server-side
    expect(
      createCollectionRequest.safeParse({ ...uploadBase, uploadCustodian: custodian }).success,
    ).toBe(true);
    // exactly one (custodianIds)
    expect(
      createCollectionRequest.safeParse({
        ...uploadBase,
        custodianIds: ['22222222-2222-4222-8222-222222222222'],
      }).success,
    ).toBe(true);
    // both
    expect(
      createCollectionRequest.safeParse({
        ...uploadBase,
        custodianIds: ['22222222-2222-4222-8222-222222222222'],
        uploadCustodian: custodian,
      }).success,
    ).toBe(false);
    // upload collections are email-only
    expect(
      createCollectionRequest.safeParse({
        ...uploadBase,
        uploadCustodian: custodian,
        sources: ['email', 'drive'],
      }).success,
    ).toBe(false);
  });

  it('provider collections still require connectorAccountId and reject uploadCustodian', () => {
    const base = {
      idempotencyKey: 'client-key-prov-1',
      name: 'Q1 snapshot',
      sources: ['email'],
      custodianIds: ['22222222-2222-4222-8222-222222222222'],
      scope: { dateRange: { kind: 'all_time' } },
    };
    expect(createCollectionRequest.safeParse(base).success).toBe(false);
    expect(
      createCollectionRequest.safeParse({
        ...base,
        connectorAccountId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
    expect(
      createCollectionRequest.safeParse({
        ...base,
        connectorAccountId: '11111111-1111-4111-8111-111111111111',
        uploadCustodian: { email: 'jane@example.com' },
      }).success,
    ).toBe(false);
  });
});

describe('production contracts', () => {
  const params = {
    name: 'Wave 1',
    selection: {
      tagIds: ['33333333-3333-4333-8333-333333333333'],
      savedSearchIds: [],
      inverted: false,
      excludePreviouslyProduced: { kind: 'any_earlier' },
      includeFamilies: true,
    },
    output: {
      mode: 'load_file',
      imageFormat: 'tiff_g4',
      includeNatives: true,
      includeText: true,
      loadFileFormats: ['dat', 'opt'],
    },
    nativePolicy: { extensions: ['xlsx'], tagIds: [], subjectToSafetyOverrides: true },
    sort: 'primary_date_asc',
    stamps: [
      { position: 'bottom_right', kind: 'bates', text: '', priority: 1, addedMarginPoints: 18 },
    ],
    redactions: { stage: 'final', color: '#000000', label: 'REDACTED', enforceImageOnly: true },
    bates: { prefix: 'ACME', startNumber: 1, digits: 8, suffix: '', numbering: 'per_page' },
    filenames: 'bates',
  };

  it('accepts a full load-file production parameter set', () => {
    expect(productionParameters.parse(params).bates.digits).toBe(8);
  });

  it('rejects unsafe bates prefixes and >6 stamps', () => {
    expect(
      productionParameters.safeParse({
        ...params,
        bates: { ...params.bates, prefix: 'BAD PREFIX!' },
      }).success,
    ).toBe(false);
    expect(
      productionParameters.safeParse({ ...params, stamps: Array(7).fill(params.stamps[0]) })
        .success,
    ).toBe(false);
  });
});

describe('export contracts', () => {
  it('validates CSV exports require columns', () => {
    const req = {
      idempotencyKey: 'client-key-456',
      kind: 'csv',
      name: 'metadata list',
      selection: { kind: 'tag', tagId: '44444444-4444-4444-8444-444444444444' },
      csv: { columns: ['evidenceId', 'sha256'], delimiter: ',' },
    };
    expect(createExportRequest.parse(req).archiveSplitMb).toBe(2048);
    expect(
      createExportRequest.safeParse({ ...req, csv: { columns: [], delimiter: ',' } }).success,
    ).toBe(false);
  });
});

describe('truthfulness notices', () => {
  it('exist for every required disclosure area', () => {
    for (const key of [
      'allTimeScope',
      'delegatedAccess',
      'bcc',
      'googleNativeExports',
      'exceptions',
      'defensibility',
      'auditScope',
      'pstExtraction',
    ] as const) {
      expect(TRUTHFULNESS_NOTICES[key].length).toBeGreaterThan(40);
    }
  });

  it('pstExtraction notice is honest about reconstruction vs. original', () => {
    expect(TRUTHFULNESS_NOTICES.pstExtraction).toMatch(/byte-for-byte/);
    expect(TRUTHFULNESS_NOTICES.pstExtraction).toMatch(/reconstruction/);
    expect(TRUTHFULNESS_NOTICES.pstExtraction).toMatch(/not provider-native/);
    expect(TRUTHFULNESS_NOTICES.pstExtraction).toMatch(/authoritative source/);
  });
});
