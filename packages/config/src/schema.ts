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
  CDFIR_APP_VERSION: z.string().default('0.1.0'),

  // --- HTTP ---
  CDFIR_API_PORT: port.default(4000),
  CDFIR_API_PUBLIC_URL: z.string().url(),
  CDFIR_WEB_PUBLIC_URL: z.string().url(),
  CDFIR_TRUST_PROXY: booleanString('false'),
  CDFIR_CORS_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  CDFIR_REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10_485_760),

  // --- PostgreSQL ---
  CDFIR_DATABASE_URL: z.string().min(1),
  /** Separate role used for migrations; the runtime role is NOT BYPASSRLS. */
  CDFIR_DATABASE_MIGRATION_URL: z.string().min(1).optional(),

  // --- Redis / queues ---
  CDFIR_REDIS_URL: z.string().min(1),

  // --- OpenSearch ---
  CDFIR_OPENSEARCH_URL: z.string().url(),
  CDFIR_OPENSEARCH_USERNAME: z.string().optional(),
  CDFIR_OPENSEARCH_PASSWORD: z.string().optional(),
  CDFIR_OPENSEARCH_INDEX_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('cdfir'),

  // --- Object storage (Wasabi / S3-compatible) ---
  CDFIR_S3_ENDPOINT: z.string().url(),
  CDFIR_S3_REGION: z.string().min(1),
  CDFIR_S3_BUCKET_EVIDENCE: z.string().min(3),
  CDFIR_S3_BUCKET_QUARANTINE: z.string().min(3),
  CDFIR_S3_ACCESS_KEY_ID: z.string().min(1),
  CDFIR_S3_SECRET_ACCESS_KEY: z.string().min(1),
  CDFIR_S3_FORCE_PATH_STYLE: booleanString('true'),
  CDFIR_S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  /**
   * How long a download script may keep asking for fresh presigned URLs.
   *
   * Presigned URLs themselves stay at 300s, deliberately: they are the thing
   * that actually reaches the bytes, and a leaked one should die quickly. This
   * governs the scoped token a script carries so it can RE-SIGN as it goes.
   *
   * A 130 GiB export is 65 parts. At 50 Mbit/s that is most of a day, so the
   * default is 24 hours. It cannot be revoked before it expires (see
   * download-token.ts), so raising this widens a real window.
   */
  CDFIR_EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(7 * 24 * 3600)
    .default(24 * 3600),

  // --- Authentik OIDC (login) ---
  CDFIR_OIDC_ISSUER: z.string().url(),
  CDFIR_OIDC_CLIENT_ID: z.string().min(1),
  CDFIR_OIDC_CLIENT_SECRET: z.string().min(1),
  CDFIR_OIDC_GROUP_CLAIM: z.string().default(''),
  CDFIR_OIDC_GROUP_ROLE_MAP: z.string().default(''), // e.g. "cdfir-admins:org_admin,cdfir-reviewers:reviewer"
  CDFIR_SESSION_SECRET: z.string().min(32),
  CDFIR_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(28_800),
  /**
   * Public create-organization in the app (after Authentik sign-up / sign-in).
   * Off by default so production can stay operator-provisioned while staging
   * tries the SaaS door.
   */
  CDFIR_SELF_SERVE_SIGNUP: booleanString('false'),

  // --- Envelope encryption ---
  CDFIR_KEK_PROVIDER: z.enum(['local-aes256gcm']).default('local-aes256gcm'),
  /** base64-encoded 32-byte master key for the local provider. */
  CDFIR_KEK_LOCAL_MASTER_KEY: z.string().min(1),
  CDFIR_KEK_ACTIVE_KEY_ID: z.string().default('kek-1'),

  // --- Provider OAuth apps (AEG-CloudDFIR's own registrations) ---
  CDFIR_MS_CLIENT_ID: z.string().default(''),
  CDFIR_MS_CLIENT_SECRET: z.string().default(''),
  CDFIR_MS_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/microsoft'),
  CDFIR_GOOGLE_CLIENT_ID: z.string().default(''),
  CDFIR_GOOGLE_CLIENT_SECRET: z.string().default(''),
  CDFIR_GOOGLE_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/google'),
  CDFIR_DROPBOX_CLIENT_ID: z.string().default(''),
  CDFIR_DROPBOX_CLIENT_SECRET: z.string().default(''),
  CDFIR_DROPBOX_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/dropbox'),
  CDFIR_SLACK_CLIENT_ID: z.string().default(''),
  CDFIR_SLACK_CLIENT_SECRET: z.string().default(''),
  CDFIR_SLACK_REDIRECT_PATH: z.string().default('/api/v1/connectors/callback/slack'),

  // --- Provider endpoint overrides (contract tests / fake server / demo) ---
  CDFIR_MS_GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  CDFIR_MS_LOGIN_BASE_URL: z.string().url().default('https://login.microsoftonline.com'),
  CDFIR_GOOGLE_API_BASE_URL: z.string().url().default('https://www.googleapis.com'),
  CDFIR_GOOGLE_OAUTH_TOKEN_URL: z.string().url().default('https://oauth2.googleapis.com/token'),
  CDFIR_DROPBOX_API_BASE_URL: z.string().url().default('https://api.dropboxapi.com/2'),
  CDFIR_DROPBOX_CONTENT_BASE_URL: z.string().url().default('https://content.dropboxapi.com/2'),
  CDFIR_DROPBOX_OAUTH_TOKEN_URL: z
    .string()
    .url()
    .default('https://api.dropboxapi.com/oauth2/token'),
  CDFIR_SLACK_API_BASE_URL: z.string().url().default('https://slack.com/api'),

  // --- ClamAV ---
  CDFIR_CLAMAV_HOST: z.string().default('clamav'),
  CDFIR_CLAMAV_PORT: port.default(3310),
  CDFIR_CLAMAV_ENABLED: booleanString('true'),

  // --- Uploaded container files (PST/OST) ---
  /** Max accepted upload size in bytes (default 10 GiB; PSTs are big). */
  // --- LibreOffice text-extraction fallback ---
  // Tika declines some formats outright (Publisher, Visio, WordPerfect). The
  // worker image already ships LibreOffice, which can often open them, so this
  // is tried before recording an unsupported_item exception. Disable it if a
  // conversion ever destabilises the worker; extraction then degrades to the
  // honest exception rather than failing.
  CDFIR_SOFFICE_FALLBACK: booleanString('true'),
  // soffice can hang indefinitely on malformed input, so the process is killed
  // at this bound. Deliberately shorter than the Tika timeout: this is a
  // best-effort second attempt, not the main path.
  CDFIR_SOFFICE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  CDFIR_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10_737_418_240),
  /** Cap on messages extracted from a single container before an honest stop. */
  CDFIR_PST_MAX_MESSAGES: z.coerce.number().int().min(1).default(250_000),
  // --- PST export (services/pst-builder) ---
  /** Path to the vendored PST writer inside the worker image. */
  CDFIR_PSTB_BIN: z.string().default('/usr/local/bin/pstb'),
  /**
   * Where a PST export is assembled before it is uploaded.
   *
   * MUST be a real named volume, NEVER `/tmp`. The worker's `/tmp` is a tmpfs
   * capped at a few hundred MB, so a multi-gigabyte PST either fills RAM or —
   * with the cap removed — lands on the container's writable layer and eats the
   * Docker disk. That disk filling once crashed PostgreSQL, and it could not
   * restart because replaying its log also needed space.
   */
  CDFIR_EXPORT_SCRATCH_DIR: z.string().default('/var/lib/cdfir/export-scratch'),
  /**
   * How long the PST writer gets. A 47 GiB mail set is hours, not minutes, so
   * this is deliberately generous; it exists to stop a wedged process holding
   * the single export lane forever, not to bound normal work.
   */
  CDFIR_PSTB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(12 * 60 * 60_000),
  /**
   * Attachments this size or larger are decoded to a spool file and streamed
   * into the PST rather than held in memory. See `services/pst-builder/cli`:
   * the buffered path cost about 3.6x the message size, and the real corpus has
   * a 672 MB item.
   */
  CDFIR_PSTB_SPOOL_THRESHOLD_BYTES: z.coerce.number().int().min(0).default(1_048_576),
  CDFIR_CRUSH_PARSER_URL: z.string().url().default('http://crush-parser:5200'),
  CDFIR_CRUSH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(30 * 60_000),
  CDFIR_IMPORT_PREVIEW_ROWS: z.coerce.number().int().min(1).max(10_000).default(200),

  // --- Extraction / Tika ---
  CDFIR_TIKA_URL: z.string().url().default('http://tika:9998'),
  CDFIR_OCR_LANGS: z.string().default('eng'),
  CDFIR_MAX_ARCHIVE_DEPTH: z.coerce.number().int().min(1).max(10).default(3),
  CDFIR_MAX_ARCHIVE_EXPANSION_RATIO: z.coerce.number().int().min(2).max(1000).default(100),
  CDFIR_MAX_ARCHIVE_TOTAL_BYTES: z.coerce.number().int().positive().default(2_147_483_648),
  /**
   * Pages rasterised and OCRed per document.
   *
   * 500, not 2000, and the number is not arbitrary: `MAX_OCR_PAGES_INDEXED` in
   * search-index.ts is 500, so pages past that were OCRed and then discarded
   * before they reached the index. The old cap let one document own an OCR
   * slot for over half an hour — a 2.7 MB `Aging Report.pdf` measured at 33
   * minutes and still running — while ~90,000 other jobs waited behind it.
   *
   * Hitting the cap is reported, never silent: `process-ocr.ts` records an
   * exception and writes `processingDetail` saying where it stopped.
   */
  CDFIR_MAX_OCR_PAGES: z.coerce.number().int().min(1).default(500),
  CDFIR_PREVIEW_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

  /**
   * How many CPU-bound jobs run at once, per stage (parse, extract, OCR,
   * preview).
   *
   * This was hardcoded at 4, which made the worker's throughput independent of
   * the machine it ran on. A five-core host sat at load 27 with a backlog of
   * 218,746 extractions and 26,957 OCR jobs — and moving to a bigger machine
   * would have changed nothing, because four is four whether there are 5 cores
   * or 50.
   *
   * Set it to roughly a quarter of the machine's cores: four stages share the
   * CPU, and tesseract itself uses more than one thread. On 32 cores, 6-8 is a
   * sensible starting point.
   *
   * NOT read from os.cpus(): inside a container that reports the host's cores,
   * not the cgroup limit, so it would over-subscribe silently. Explicit beats
   * clever here.
   *
   * Only CPU-bound stages scale. Provider fetches stay put — they are limited
   * by Microsoft and Google rate limits, not by this machine, and raising them
   * buys throttling rather than throughput.
   */
  CDFIR_WORKER_CPU_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  // --- Demo mode (never enable in production) ---
  CDFIR_DEMO_MODE: booleanString('false'),
  CDFIR_DEMO_FAKE_PROVIDER_URL: z.string().url().optional(),

  // --- Observability ---
  CDFIR_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  CDFIR_OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  CDFIR_METRICS_PORT: port.default(9464),
  CDFIR_WORKER_HEALTH_PORT: port.default(5100),

  /**
   * Dead-man's-switch ping URL for the host health checker (healthchecks.io).
   *
   * No service reads this. It is here so the key is a known, documented,
   * REDACTED setting rather than an undeclared string in .env — it is a
   * capability, and anyone holding it can post a fake "ok" and mute the alarm.
   * That is why it is in SECRET_KEYS below.
   *
   * Deliberately NOT .url(): the api and worker validate this whole schema at
   * startup and refuse to boot on a bad value. A monitoring typo must not be
   * able to take the product down. The checker itself fails loudly on a URL it
   * cannot reach, which is the right place for that error.
   *
   * Empty means not configured, and the checker then exits non-zero instead of
   * looking fine. See packages/monitoring/src/report.ts.
   */
  CDFIR_HEALTHCHECK_PING_URL: z.string().default(''),
});

export type AppConfig = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

const SECRET_KEYS: ReadonlySet<string> = new Set([
  'CDFIR_DATABASE_URL',
  'CDFIR_DATABASE_MIGRATION_URL',
  'CDFIR_REDIS_URL',
  'CDFIR_OPENSEARCH_PASSWORD',
  'CDFIR_S3_SECRET_ACCESS_KEY',
  'CDFIR_S3_ACCESS_KEY_ID',
  'CDFIR_OIDC_CLIENT_SECRET',
  'CDFIR_SESSION_SECRET',
  'CDFIR_KEK_LOCAL_MASTER_KEY',
  'CDFIR_MS_CLIENT_SECRET',
  'CDFIR_GOOGLE_CLIENT_SECRET',
  'CDFIR_DROPBOX_CLIENT_SECRET',
  'CDFIR_SLACK_CLIENT_SECRET',
  // Holding this URL is enough to silence every alert by pinging "ok".
  'CDFIR_HEALTHCHECK_PING_URL',
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
  if (result.data.NODE_ENV === 'production' && result.data.CDFIR_DEMO_MODE) {
    throw new ConfigValidationError([
      'CDFIR_DEMO_MODE must not be enabled when NODE_ENV=production',
    ]);
  }
  return result.data;
}

/** Copy of the config safe for diagnostic logging: secret values elided. */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, SECRET_KEYS.has(k) ? '[redacted]' : v]),
  );
}
