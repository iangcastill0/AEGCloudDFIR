/**
 * Lightweight typed stubs for processor tests (compiled by vitest only; this
 * directory is excluded from the production tsc build like *.test.ts files).
 */
import { vi, type Mock } from 'vitest';
import type { PrismaClient } from '@aeg-clouddfir/database';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { WorkerContext } from '../context.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const COLLECTION = '22222222-2222-4222-8222-222222222222';
export const CUSTODIAN = '33333333-3333-4333-8333-333333333333';
export const ACCOUNT = '44444444-4444-4444-8444-444444444444';
export const EVIDENCE = '55555555-5555-4555-8555-555555555555';
export const EXPORT_ID = '66666666-6666-4666-8666-666666666666';
export const RUN_ID = '77777777-7777-4777-8777-777777777777';
export const PRODUCTION_ID = '88888888-8888-4888-8888-888888888888';

export interface FakeModel {
  findUnique: Mock;
  findUniqueOrThrow: Mock;
  findFirst: Mock;
  findMany: Mock;
  create: Mock;
  createMany: Mock;
  update: Mock;
  updateMany: Mock;
  upsert: Mock;
  deleteMany: Mock;
  count: Mock;
  groupBy: Mock;
}

export function fakeModel(): FakeModel {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'row' }),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'created' }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    upsert: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  };
}

const MODEL_NAMES = [
  'collection',
  'collectionCustodian',
  'collectionCheckpoint',
  'collectionItem',
  'collectionException',
  'custodian',
  'connectorAccount',
  'connectorSecret',
  'evidenceItem',
  'evidenceBlob',
  'emailMetadata',
  'driveMetadata',
  'header',
  'emailParticipant',
  'extractedText',
  'ocrPage',
  'preview',
  'malwareScan',
  'tagAssignment',
  'caseItem',
  'savedSearch',
  'evidenceRelationship',
  'outboxEvent',
  'jobAttempt',
  'export',
  'exportItem',
  'production',
  'productionRun',
  'productionItem',
  'productionException',
  'batesReservation',
  'auditEvent',
  'auditRecord',
] as const;

export type FakeTx = Record<(typeof MODEL_NAMES)[number], FakeModel> & {
  $executeRaw: Mock;
  $queryRaw: Mock;
};

export function fakeTx(): FakeTx {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
  } as Record<string, unknown>;
  for (const name of MODEL_NAMES) {
    tx[name] = fakeModel();
  }
  const t = tx as FakeTx;
  // appendAuditEvent needs a chain head lookup and a created id.
  t.auditEvent.findFirst.mockResolvedValue(null);
  t.auditEvent.create.mockResolvedValue({ id: 'audit-1' });
  return t;
}

export function fakePrisma(tx: FakeTx): PrismaClient {
  return {
    $transaction: (fn: (t: FakeTx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
}

export const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

export function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    CDFIR_APP_VERSION: '0.1.0-test',
    CDFIR_TIKA_URL: 'http://tika.test:9998',
    CDFIR_CLAMAV_HOST: 'clam.test',
    CDFIR_CLAMAV_PORT: 3310,
    CDFIR_CLAMAV_ENABLED: true,
    CDFIR_OCR_LANGS: 'eng',
    CDFIR_MAX_OCR_PAGES: 2000,
    CDFIR_S3_BUCKET_EVIDENCE: 'evidence-test',
    CDFIR_S3_BUCKET_QUARANTINE: 'quarantine-test',
    CDFIR_MS_GRAPH_BASE_URL: 'http://graph.test',
    CDFIR_MS_LOGIN_BASE_URL: 'http://login.test',
    CDFIR_MS_CLIENT_ID: 'ms-client',
    CDFIR_MS_CLIENT_SECRET: 'ms-secret',
    CDFIR_GOOGLE_API_BASE_URL: 'http://google.test',
    CDFIR_GOOGLE_OAUTH_TOKEN_URL: 'http://google.test/token',
    CDFIR_GOOGLE_CLIENT_ID: 'g-client',
    CDFIR_GOOGLE_CLIENT_SECRET: 'g-secret',
    ...overrides,
  } as AppConfig;
}

export interface FakeCtxOptions {
  tx?: FakeTx;
  config?: Partial<AppConfig>;
}

export interface FakeCtx {
  ctx: WorkerContext;
  tx: FakeTx;
  store: {
    stageStream: Mock;
    promoteToOriginal: Mock;
    putDerivative: Mock;
    putManifest: Mock;
    getStream: Mock;
    verifyObjectHash: Mock;
  };
  search: { indexBulk: Mock; search: Mock; ensureIndex: Mock };
  s3Send: Mock;
  enqueue: Mock;
}

export function fakeCtx(options: FakeCtxOptions = {}): FakeCtx {
  const tx = options.tx ?? fakeTx();
  const store = {
    stageStream: vi.fn().mockResolvedValue({
      stagingKey: `tenants/${TENANT}/staging/x`,
      sha256: 'a'.repeat(64),
      size: 3,
    }),
    promoteToOriginal: vi.fn().mockResolvedValue({
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`,
      bucket: 'evidence-test',
    }),
    putDerivative: vi.fn().mockResolvedValue({
      objectKey: `tenants/${TENANT}/derivatives/x`,
      sha256: 'b'.repeat(64),
      size: 1,
    }),
    putManifest: vi.fn().mockResolvedValue({
      objectKey: `tenants/${TENANT}/manifests/${COLLECTION}/manifest.json`,
      sha256: 'c'.repeat(64),
    }),
    getStream: vi.fn(),
    verifyObjectHash: vi
      .fn()
      .mockResolvedValue({ ok: true, actualSha256: 'a'.repeat(64), size: 3 }),
  };
  const search = {
    indexBulk: vi.fn().mockResolvedValue({ indexed: 1, errors: [] }),
    search: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    ensureIndex: vi.fn().mockResolvedValue({ created: false, indexName: 'test' }),
  };
  const s3Send = vi.fn().mockResolvedValue({});
  const enqueue = vi.fn().mockResolvedValue(undefined);

  const ctx: WorkerContext = {
    config: fakeConfig(options.config),
    prisma: fakePrisma(tx),
    redis: {} as WorkerContext['redis'],
    log: silentLog,
    s3: { send: s3Send } as unknown as WorkerContext['s3'],
    store: store as unknown as WorkerContext['store'],
    search: search as unknown as WorkerContext['search'],
    kek: {
      activeKeyId: 'kek-1',
      wrapDek: vi.fn(),
      unwrapDek: vi.fn(),
    } as unknown as WorkerContext['kek'],
    enqueuer: { enqueue },
    manifestSigningKey: Buffer.alloc(32, 7),
  };
  return { ctx, tx, store, search, s3Send, enqueue };
}

/** All rows passed to a fake model's createMany across calls. */
export function createManyRows(model: FakeModel): Record<string, unknown>[] {
  return model.createMany.mock.calls.flatMap(
    (call) => (call[0] as { data: Record<string, unknown>[] }).data,
  );
}
