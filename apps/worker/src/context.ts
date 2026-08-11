import { hkdfSync } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '@evidencevault/config';
import {
  LocalAesKeyEncryptionProvider,
  type KeyEncryptionProvider,
  type PrismaClient,
} from '@evidencevault/database';
import { EvidenceObjectStore } from '@evidencevault/evidence';
import { OpenSearchAdapter, type SearchAdapter } from '@evidencevault/search';
import type { Redis } from 'ioredis';
import type { DispatcherLogger, JobEnqueuer } from './outbox/dispatcher.js';

/**
 * Structural ports over the workspace packages so processors depend on the
 * minimum surface (and tests can substitute vi.fn implementations without
 * subclassing the real S3/OpenSearch clients).
 */
export type ObjectStorePort = Pick<
  EvidenceObjectStore,
  | 'stageStream'
  | 'promoteToOriginal'
  | 'putDerivative'
  | 'putManifest'
  | 'getStream'
  | 'verifyObjectHash'
>;

export type SearchPort = Pick<SearchAdapter, 'indexBulk' | 'search' | 'ensureIndex'>;

export interface WorkerContext {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  log: DispatcherLogger;
  /** Raw S3 client for operations the store does not expose (quarantine delete, production puts). */
  s3: S3Client;
  store: ObjectStorePort;
  search: SearchPort;
  kek: KeyEncryptionProvider;
  enqueuer: JobEnqueuer;
  /** HKDF-derived HMAC key for collection manifest signatures. */
  manifestSigningKey: Buffer;
}

/** Derive the manifest signing key from the local master key (never used raw). */
export function deriveManifestSigningKey(masterKeyBase64: string): Buffer {
  const ikm = Buffer.from(masterKeyBase64, 'base64');
  const derived = hkdfSync(
    'sha256',
    ikm,
    Buffer.from('evidencevault', 'utf8'),
    Buffer.from('manifest-signing-v1', 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

export interface WorkerContextDeps {
  prisma: PrismaClient;
  redis: Redis;
  log: DispatcherLogger;
  enqueuer: JobEnqueuer;
}

/** Build the shared per-process context once in main(). */
export function buildWorkerContext(config: AppConfig, deps: WorkerContextDeps): WorkerContext {
  const s3 = new S3Client({
    endpoint: config.EV_S3_ENDPOINT,
    region: config.EV_S3_REGION,
    forcePathStyle: config.EV_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.EV_S3_ACCESS_KEY_ID,
      secretAccessKey: config.EV_S3_SECRET_ACCESS_KEY,
    },
  });
  const store = new EvidenceObjectStore({
    s3,
    evidenceBucket: config.EV_S3_BUCKET_EVIDENCE,
    quarantineBucket: config.EV_S3_BUCKET_QUARANTINE,
    presignTtlSeconds: config.EV_S3_PRESIGN_TTL_SECONDS,
  });
  const search = new OpenSearchAdapter({
    node: config.EV_OPENSEARCH_URL,
    username: config.EV_OPENSEARCH_USERNAME,
    password: config.EV_OPENSEARCH_PASSWORD,
    indexPrefix: config.EV_OPENSEARCH_INDEX_PREFIX,
  });
  const kek = new LocalAesKeyEncryptionProvider(
    { [config.EV_KEK_ACTIVE_KEY_ID]: config.EV_KEK_LOCAL_MASTER_KEY },
    config.EV_KEK_ACTIVE_KEY_ID,
  );
  return {
    config,
    prisma: deps.prisma,
    redis: deps.redis,
    log: deps.log,
    s3,
    store,
    search,
    kek,
    enqueuer: deps.enqueuer,
    manifestSigningKey: deriveManifestSigningKey(config.EV_KEK_LOCAL_MASTER_KEY),
  };
}

/**
 * Sanitize an error message for persistence/logging: strips query strings
 * (which could carry tokens or signatures) and caps the length. Never returns
 * header values or presigned URLs.
 */
export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\?[^\s'"]*/g, '?[elided]').slice(0, 500);
}
