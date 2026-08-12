import { z } from 'zod';

/** zod v4 applies .default() only before .transform(), so bake the default in. */
const booleanString = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Complete environment schema for every AEG-CloudDFIR service.
 * Services validate at startup and crash fast with a readable report;
 * secrets are never echoed back in validation errors (values are elided).
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EV_APP_VERSION: z.string().default('0.1.0'),

  // --- HTTP ---
  EV_API_PORT: port.default(4000),
  EV_API_PUBLIC_URL: z.string().url(),
  EV_WEB_PUBLIC_URL: z.string().url(),
  EV_TRUST_PROXY: booleanString('false'),
  EV_CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  EV_REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10_485_760),

  // --- PostgreSQL ---
  EV_DATABASE_URL: z.string().min(1),
  /** Separate role used for migrations; the runtime role is NOT BYPASSRLS. */
  EV_DATABASE_MIGRATION_URL: z.string().min(1).optional(),

  // --- Redis / queues ---
  EV_REDIS_URL: z.string().min(1),

  // --- OpenSearch ---
  EV_OPENSEARCH_URL: z.string().url(),
  EV_OPENSEARCH_USERNAME: z.string().optional(),
  EV_OPENSEARCH_PASSWORD: z.string().optional(),
  EV_OPENSEARCH_INDEX_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('evidencevault'),

  // --- Object storage (Wasabi / S3-compatible) ---
  EV_S3_ENDPOINT: z.string().url(),
  EV_S3_REGION: z.string().min(1),
  EV_S3_BUCKET_EVIDENCE: z.string().min(3),
  EV_S3_BUCKET_QUARANTINE: z.string().min(3),
  EV_S3_ACCESS_KEY_ID: z.string().min(1),
  EV_S3_SECRET_ACCESS_KEY: z.string().min(1),
  EV_S3_FORCE_PATH_STYLE: booleanString('true'),
  EV_S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  // --- Authentik OIDC (login) ---
  EV_OIDC_ISSUER: z.string().url(),
  EV_OIDC_CLIENT_ID: z.string().min(1),
  EV_OIDC_CLIENT_SECRET: z.string().min(1),
  EV_OIDC_GROUP_CLAIM: z.string().default(''),
  EV_OIDC_GROUP_ROLE_MAP: z.string().default(''), // e.g. "ev-admins:org_admin,ev-reviewers:reviewer"
  EV_SESSION_SECRET: z.string().min(32),
  EV_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(28_800),

  // --- Envelope encryption ---
  EV_KEK_PROVIDER: z.enum(['local-aes256gcm']).default('local-aes256gcm'),
  /** base64-encoded 32-byte master key for the local provider. */
  EV_KEK_LOCAL_MASTER_KEY: z.string().min(1),
  EV_KEK_ACTIVE_KEY_ID: z.string().default('kek-1'),

  // --- Provider OAuth apps (AEG-CloudDFIR's own registrations) ---
  EV_MS_CLIENT_ID: z.string().default(''),
  EV_MS_CLIENT_SECRET: z.string().default(''),
  EV_MS_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/microsoft'),
  EV_GOOGLE_CLIENT_ID: z.string().default(''),
  EV_GOOGLE_CLIENT_SECRET: z.string().default(''),
  EV_GOOGLE_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/google'),

  // --- Provider endpoint overrides (contract tests / fake server / demo) ---
  EV_MS_GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  EV_MS_LOGIN_BASE_URL: z.string().url().default('https://login.microsoftonline.com'),
  EV_GOOGLE_API_BASE_URL: z.string().url().default('https://www.googleapis.com'),
  EV_GOOGLE_OAUTH_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),

  // --- ClamAV ---
  EV_CLAMAV_HOST: z.string().default('clamav'),
  EV_CLAMAV_PORT: port.default(3310),
  EV_CLAMAV_ENABLED: booleanString('true'),

  // --- Extraction / Tika ---
  EV_TIKA_URL: z.string().url().default('http://tika:9998'),
  EV_OCR_LANGS: z.string().default('eng'),
  EV_MAX_ARCHIVE_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
  EV_MAX_ARCHIVE_EXPANSION_RATIO: z.coerce.number().int().min(2).max(1000).default(100),
  EV_MAX_ARCHIVE_TOTAL_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
  EV_MAX_OCR_PAGES: z.coerce.number().int().min(1).default(2000),
  EV_PREVIEW_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

  // --- Demo mode (never enable in production) ---
  EV_DEMO_MODE: booleanString('false'),
  EV_DEMO_FAKE_PROVIDER_URL: z.string().url().optional(),

  // --- Observability ---
  EV_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  EV_OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  EV_METRICS_PORT: port.default(9464),
  EV_WORKER_HEALTH_PORT: port.default(5100),
});

export type AppConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

const SECRET_KEYS: ReadonlySet<string> = new Set([
  'EV_DATABASE_URL',
  'EV_DATABASE_MIGRATION_URL',
  'EV_REDIS_URL',
  'EV_OPENSEARCH_PASSWORD',
  'EV_S3_SECRET_ACCESS_KEY',
  'EV_S3_ACCESS_KEY_ID',
  'EV_OIDC_CLIENT_SECRET',
  'EV_SESSION_SECRET',
  'EV_KEK_LOCAL_MASTER_KEY',
  'EV_MS_CLIENT_SECRET',
  'EV_GOOGLE_CLIENT_SECRET',
]);

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate the process environment. Throws ConfigValidationError with
 * key-level messages; secret VALUES are never included in the error text.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.');
      return `${key}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }
  if (result.data.NODE_ENV === 'production' && result.data.EV_DEMO_MODE) {
    throw new ConfigValidationError(['EV_DEMO_MODE must not be enabled when NODE_ENV=production']);
  }
  return result.data;
}

/** Copy of the config safe for diagnostic logging: secret values elided. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, SECRET_KEYS.has(k) ? '[redacted]' : v]),
  );
}
