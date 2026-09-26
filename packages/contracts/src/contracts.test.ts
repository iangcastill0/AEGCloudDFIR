import { describe, expect, it } from 'vitest';
import {
  collectionScope,
  connectorListResponse,
  provider,
  completeness,
  createCollectionRequest,
  createExportRequest,
  productionParameters,
  timezoneId,
  TRUTHFULNESS_NOTICES,
  createTenantRequest,
  createInviteRequest,
  joinRequest,
  joinLinkResponse,
  // Imported through ./index.js on purpose: `export * from './collections.js'`
  // is what re-exports these, and this import is the proof that it does.
  collectionThroughputResponse,
  collectionThroughputState,
  attachImportRequest,
  importArtifact,
  importDetailResponse,
  importSearchQuery,
  importSearchResponse,
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

describe('forensic import contracts', () => {
  it('accepts a bounded artifact preview and case attachment', () => {
    expect(
      importArtifact.parse({
        id: '55555555-5555-4555-8555-555555555555',
        parentId: null,
        evidenceItemId: null,
        path: 'folder/events.db',
        name: 'events.db',
        kind: 'file',
        mimeType: 'application/vnd.sqlite3',
        size: '2048',
        sha256: 'a'.repeat(64),
        viewerType: 'table',
        metadata: { Tables: '1' },
        preview: { events: { rows: [[1, 'login']], truncated: true } },
        textIndex: 'login',
      }),
    ).toBeTruthy();
    expect(
      attachImportRequest.parse({ caseId: '11111111-1111-4111-8111-111111111111' }),
    ).toBeTruthy();
  });

  it('requires the import detail status vocabulary', () => {
    const base = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'phone.zip',
      status: 'completed',
      sourceEvidenceItemId: '66666666-6666-4666-8666-666666666666',
      createdById: '77777777-7777-4777-8777-777777777777',
      parserVersion: 'crush@abc',
      artifactCount: 2,
      error: '',
      caseIds: [],
      createdAt: '2026-09-24T12:00:00.000Z',
      updatedAt: '2026-09-24T12:01:00.000Z',
    };
    expect(importDetailResponse.safeParse(base).success).toBe(true);
    expect(importDetailResponse.safeParse({ ...base, status: 'done' }).success).toBe(false);
  });

  it('bounds import content searches and returns a safe match snippet', () => {
    expect(importSearchQuery.parse({ q: 'login', limit: '25' })).toEqual({
      q: 'login',
      limit: 25,
    });
    expect(importSearchQuery.safeParse({ q: '' }).success).toBe(false);
    expect(importSearchQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(
      importSearchResponse.parse({
        items: [
          {
            artifact: {
              id: '55555555-5555-4555-8555-555555555555',
              parentId: null,
              evidenceItemId: null,
              path: 'folder/events.db',
              name: 'events.db',
              kind: 'file',
              mimeType: 'application/vnd.sqlite3',
              size: '2048',
              sha256: 'a'.repeat(64),
              viewerType: 'table',
              metadata: {},
              preview: null,
              textIndex: '',
            },
            matchLocation: 'content',
            snippet: 'user login succeeded',
          },
        ],
        nextCursor: null,
      }).items[0]?.snippet,
    ).toBe('user login succeeded');
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

  /**
   * A native export hands over natives. An `.eml` already carries its
   * attachments, so writing them out again puts a second copy of the same
   * bytes in the archive — 30 GB of one real 130 GiB export. A caller that
   * says nothing must get the layout the operator asked for.
   */
  it('leaves email attachments inside the parent unless asked otherwise', () => {
    const req = {
      idempotencyKey: 'client-key-789',
      kind: 'native',
      name: 'natives',
      selection: { kind: 'tag', tagId: '44444444-4444-4444-8444-444444444444' },
    };
    expect(createExportRequest.parse(req).attachments).toBe('inline');
    expect(createExportRequest.parse({ ...req, attachments: 'extracted' }).attachments).toBe(
      'extracted',
    );
    expect(createExportRequest.safeParse({ ...req, attachments: 'loose' }).success).toBe(false);
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

describe('connector list', () => {
  // Exactly what staging holds: an automatic upload connector alongside real
  // Google ones. The web schema declared only microsoft and google, so this one
  // upload row made the entire list fail to parse and the page showed
  // "Something went wrong" with no connectors listed.
  const rows = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      provider: 'upload',
      mode: 'organization',
      label: 'Uploads',
      externalIdentity: '',
      status: 'connected',
      statusDetail: '',
      createdAt: '2026-08-21T00:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      provider: 'google',
      mode: 'delegated',
      label: 'Google Workspace (personal) 2026-08-21',
      externalIdentity: 'ian@example.com',
      status: 'connected',
      statusDetail: '',
      createdAt: '2026-08-21T01:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      provider: 'google',
      mode: 'delegated',
      label: 'Google Workspace (personal) 2026-08-21',
      externalIdentity: '',
      status: 'pending_auth',
      statusDetail: '',
      createdAt: '2026-08-21T01:05:00.000Z',
    },
  ];

  it('parses a list that includes the automatic upload connector', () => {
    const parsed = connectorListResponse.safeParse({ items: rows, nextCursor: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.items).toHaveLength(3);
  });

  it('accepts every status the database can hold', () => {
    for (const status of ['pending_auth', 'connected', 'error', 'revoked']) {
      const parsed = connectorListResponse.safeParse({
        items: [{ ...rows[0], status }],
        nextCursor: null,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('still rejects a provider the app does not support', () => {
    // 'dropbox' used to be the example here and became real, which is exactly
    // what should happen: the guard failed loudly the moment support landed.
    // The negative case must be a value that will never be a provider.
    const parsed = connectorListResponse.safeParse({
      items: [{ ...rows[0], provider: 'not-a-real-provider' }],
      nextCursor: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the provider enum covers every provider a row can hold', () => {
  // Adding a provider in three places and forgetting the fourth is what shipped
  // twice now: once as `upload` breaking the connector list, once as `imap`
  // making the browser discard a connector it had just created.
  it('accepts every value the database Provider enum has', () => {
    for (const value of ['microsoft', 'google', 'imap', 'upload']) {
      expect(provider.safeParse(value).success).toBe(true);
    }
  });

  it('still rejects a provider the app does not support', () => {
    expect(provider.safeParse('not-a-real-provider').success).toBe(false);
    expect(provider.safeParse('').success).toBe(false);
  });
});

describe('self-serve tenancy contracts', () => {
  it('accepts a create-tenant body', () => {
    expect(createTenantRequest.safeParse({ name: 'Acme', slug: 'acme' }).success).toBe(true);
    expect(joinRequest.safeParse({ token: 'x'.repeat(16) }).success).toBe(true);
    expect(joinRequest.safeParse({ token: 'short' }).success).toBe(false);
    expect(
      createInviteRequest.safeParse({ email: 'pat@example.com', role: 'reviewer' }).success,
    ).toBe(true);
    // Public signup does not verify mailbox ownership. Elevated roles on an
    // email invite would let anyone who saw the URL register as that address
    // and become org_admin without controlling the mailbox.
    expect(
      createInviteRequest.safeParse({ email: 'pat@example.com', role: 'org_admin' }).success,
    ).toBe(false);
    expect(
      createInviteRequest.safeParse({ email: 'pat@example.com', role: 'case_manager' }).success,
    ).toBe(false);
    expect(
      joinLinkResponse.safeParse({
        inviteUrl: 'https://app.ev.test/join?token=abc',
        role: 'reviewer',
      }).success,
    ).toBe(true);
  });
});

describe('collection throughput contract', () => {
  /**
   * Round-tripped because this schema is what the browser validates the API's
   * answer against. A field the API sends under a different name type-checks
   * fine on both sides and then fails at runtime in front of a user.
   *
   * The figures are the real ones: 185,379 provider items became 434,910
   * evidence items and 130 GB between 2026-09-10 19:43 and 2026-09-14 16:56;
   * acquisition took 66.00 h of the 93.22 h run; per-minute pace p10 54, p50 101,
   * p90 162, peak 1,140.
   */
  const pace = {
    itemsPerMinute: 101,
    bytesPerMinute: 2170880,
    p10ItemsPerMinute: 54,
    p50ItemsPerMinute: 101,
    p90ItemsPerMinute: 162,
    peakItemsPerMinute: 1140,
  };

  const body = {
    collectionId: '00000000-0000-4000-8000-0000000000c1',
    status: 'fetching',
    window: 'history',
    windowName: 'whole run, 198 buckets of 20 minutes each',
    bucketMinutes: 20,
    buckets: [
      {
        startedAt: '2026-09-10T19:43:00.000Z',
        minutesFromStart: 0,
        items: 2020,
        bytes: 43417600,
        cumulativeBytes: 43417600,
        idle: false,
      },
      {
        startedAt: '2026-09-10T20:03:00.000Z',
        minutesFromStart: 20,
        items: 0,
        bytes: 0,
        cumulativeBytes: 43417600,
        idle: true,
      },
    ],
    totals: {
      items: 434910,
      bytes: 139586437120,
      firstAcquiredAt: '2026-09-10T19:43:00.000Z',
      lastAcquiredAt: '2026-09-13T13:43:00.000Z',
      acquisitionElapsedMs: 66 * 3600_000,
      runElapsedMs: Math.round(93.22 * 3600_000),
      idleBuckets: 12,
    },
    acquisition: {
      phase: 'acquisition',
      done: 434910,
      total: 434910,
      percent: 100,
      inFlight: 0,
      elapsedMs: 66 * 3600_000,
      pace,
    },
    processing: {
      phase: 'processing',
      done: 134910,
      total: 434910,
      percent: 31,
      inFlight: 300000,
      elapsedMs: Math.round(27.22 * 3600_000),
      pace: {
        itemsPerMinute: null,
        bytesPerMinute: null,
        p10ItemsPerMinute: null,
        p50ItemsPerMinute: null,
        p90ItemsPerMinute: null,
        peakItemsPerMinute: null,
      },
    },
    itemStates: {
      discovered: 0,
      fetching: 0,
      preserved: 300000,
      processed: 0,
      indexed: 134910,
      failed: 0,
      skipped: 0,
    },
    state: 'processing',
    stateLabel: 'Processing',
    health: 'healthy',
    rateLimitWaitMs: 507000,
    exceptionCount: 0,
  };

  it('round-trips the real run\u2019s numbers unchanged', () => {
    const parsed = collectionThroughputResponse.parse(body);
    expect(parsed.totals.items).toBe(434910);
    expect(parsed.totals.bytes).toBe(139586437120);
    expect(parsed.buckets[1]?.idle).toBe(true);
    // The tail is the difference of the two clocks, and it must survive parsing.
    expect(
      (parsed.totals.runElapsedMs - parsed.totals.acquisitionElapsedMs) / 3600_000,
    ).toBeCloseTo(27.22, 2);
  });

  it('accepts a null pace, because "not measured yet" is not zero', () => {
    const measuring = {
      ...body,
      state: 'measuring',
      stateLabel: 'Measuring',
      acquisition: {
        ...body.acquisition,
        pace: {
          itemsPerMinute: null,
          bytesPerMinute: null,
          p10ItemsPerMinute: null,
          p50ItemsPerMinute: null,
          p90ItemsPerMinute: null,
          peakItemsPerMinute: null,
        },
      },
    };
    expect(collectionThroughputResponse.safeParse(measuring).success).toBe(true);
  });

  it('accepts a null total and percent while the denominator is moving', () => {
    // A fraction of an unknown total is a lie: this run's own total moved from
    // 185,379 provider items to 434,910 evidence items.
    const discovering = {
      ...body,
      state: 'discovering',
      stateLabel: 'Discovering',
      acquisition: { ...body.acquisition, total: null, percent: null },
    };
    expect(collectionThroughputResponse.safeParse(discovering).success).toBe(true);
  });

  it('rejects a state the server does not define, so the two cannot drift', () => {
    expect(collectionThroughputResponse.safeParse({ ...body, state: 'almost_done' }).success).toBe(
      false,
    );
    expect(collectionThroughputState.safeParse('eta').success).toBe(false);
  });

  it('holds every state the server can decide', () => {
    for (const state of [
      'measuring',
      'discovering',
      'fetching',
      'processing',
      'slow',
      'rate_limited',
      'stalled',
      'finished',
    ]) {
      expect(collectionThroughputState.safeParse(state).success).toBe(true);
    }
  });

  it('rejects a missing phase rather than defaulting one in', () => {
    const { processing, ...withoutTail } = body;
    void processing;
    expect(collectionThroughputResponse.safeParse(withoutTail).success).toBe(false);
  });
});
