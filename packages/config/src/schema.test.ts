import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from './schema.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  CDFIR_API_PUBLIC_URL: 'http://localhost:4000',
  CDFIR_WEB_PUBLIC_URL: 'http://localhost:3000',
  CDFIR_DATABASE_URL: 'postgresql://ev:pw@localhost:5432/ev',
  CDFIR_REDIS_URL: 'redis://localhost:6379',
  CDFIR_OPENSEARCH_URL: 'http://localhost:9200',
  CDFIR_S3_ENDPOINT: 'http://localhost:9000',
  CDFIR_S3_REGION: 'us-east-1',
  CDFIR_S3_BUCKET_EVIDENCE: 'cdfir-evidence',
  CDFIR_S3_BUCKET_QUARANTINE: 'cdfir-quarantine',
  CDFIR_S3_ACCESS_KEY_ID: 'minioadmin',
  CDFIR_S3_SECRET_ACCESS_KEY: 'a-secret-value',
  CDFIR_OIDC_ISSUER: 'http://localhost:9443/application/o/cdfir/',
  CDFIR_OIDC_CLIENT_ID: 'cdfir',
  CDFIR_OIDC_CLIENT_SECRET: 'an-oidc-secret',
  CDFIR_SESSION_SECRET: 'x'.repeat(48),
  CDFIR_KEK_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  it('accepts a complete valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.CDFIR_API_PORT).toBe(4000);
    expect(config.CDFIR_S3_PRESIGN_TTL_SECONDS).toBe(300);
    expect(config.CDFIR_DEMO_MODE).toBe(false);
    expect(config.CDFIR_SELF_SERVE_SIGNUP).toBe(false);
    expect(config.CDFIR_MAX_ARCHIVE_DEPTH).toBe(3);
    expect(config.CDFIR_CRUSH_PARSER_URL).toBe('http://crush-parser:5200');
    expect(config.CDFIR_IMPORT_PREVIEW_ROWS).toBe(200);
    expect(config.CDFIR_CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('parses comma-separated CORS origins', () => {
    const config = loadConfig({
      ...validEnv,
      CDFIR_CORS_ALLOWED_ORIGINS: 'http://a.example, http://b.example',
    });
    expect(config.CDFIR_CORS_ALLOWED_ORIGINS).toEqual(['http://a.example', 'http://b.example']);
  });

  it('fails fast with key-level messages and no secret values', () => {
    const env = { ...validEnv };
    delete env.CDFIR_DATABASE_URL;
    env.CDFIR_S3_ENDPOINT = 'not-a-url';
    try {
      loadConfig(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('CDFIR_DATABASE_URL');
      expect(message).toContain('CDFIR_S3_ENDPOINT');
      // secret values from the env must never appear in the error text
      expect(message).not.toContain('a-secret-value');
      expect(message).not.toContain('an-oidc-secret');
    }
  });

  it('rejects demo mode in production', () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: 'production', CDFIR_DEMO_MODE: 'true' }),
    ).toThrow(/CDFIR_DEMO_MODE/);
  });

  it('rejects out-of-range presign TTL', () => {
    expect(() => loadConfig({ ...validEnv, CDFIR_S3_PRESIGN_TTL_SECONDS: '86400' })).toThrow(
      /CDFIR_S3_PRESIGN_TTL_SECONDS/,
    );
  });

  it('redactConfig elides every secret key', () => {
    const redacted = redactConfig(loadConfig(validEnv));
    expect(redacted.CDFIR_DATABASE_URL).toBe('[redacted]');
    expect(redacted.CDFIR_S3_SECRET_ACCESS_KEY).toBe('[redacted]');
    expect(redacted.CDFIR_OIDC_CLIENT_SECRET).toBe('[redacted]');
    expect(redacted.CDFIR_SESSION_SECRET).toBe('[redacted]');
    expect(redacted.CDFIR_KEK_LOCAL_MASTER_KEY).toBe('[redacted]');
    expect(redacted.CDFIR_API_PORT).toBe(4000);
  });
});

describe('Dropbox connector configuration', () => {
  it('defaults the redirect path to the route the API serves', () => {
    // This exact string is pasted into the Dropbox app console. A mismatch of
    // one character produces "redirect_uri did not match", which reads like a
    // Dropbox problem rather than a config typo.
    expect(loadConfig(validEnv).CDFIR_DROPBOX_REDIRECT_PATH).toBe(
      '/api/v1/connectors/callback/dropbox',
    );
  });

  it('starts empty, so an unconfigured Dropbox app cannot half-work', () => {
    const config = loadConfig(validEnv);
    expect(config.CDFIR_DROPBOX_CLIENT_ID).toBe('');
    expect(config.CDFIR_DROPBOX_CLIENT_SECRET).toBe('');
  });

  it('never prints the app secret', () => {
    // A secret in a log or an error page is a secret that has to be rotated.
    const redacted = redactConfig(
      loadConfig({ ...validEnv, CDFIR_DROPBOX_CLIENT_SECRET: 'the-real-secret' }),
    );
    expect(JSON.stringify(redacted)).not.toContain('the-real-secret');
  });
});

describe('CDFIR_WORKER_CPU_CONCURRENCY', () => {
  /**
   * How many CPU-bound jobs the worker runs at once, per stage. This was
   * hardcoded at 4, which made throughput independent of the machine: a
   * five-core host sat at load 27 with 218,746 extractions and 26,957 OCR jobs
   * queued, and a 32-core host would have run the same four at a time.
   */
  it('defaults to the value that used to be hardcoded', () => {
    // An operator who never sets it must get exactly today's behaviour.
    expect(loadConfig(validEnv).CDFIR_WORKER_CPU_CONCURRENCY).toBe(4);
  });

  it('coerces the string a .env file actually supplies', () => {
    const config = loadConfig({ ...validEnv, CDFIR_WORKER_CPU_CONCURRENCY: '8' });
    expect(config.CDFIR_WORKER_CPU_CONCURRENCY).toBe(8);
  });

  it('refuses zero, which would stop those stages entirely', () => {
    expect(() => loadConfig({ ...validEnv, CDFIR_WORKER_CPU_CONCURRENCY: '0' })).toThrow();
  });

  it('refuses a value no machine could honour', () => {
    // A typo does not fail loudly at runtime, it just thrashes. Better to
    // refuse to boot than to spend a day wondering why everything is slow.
    expect(() => loadConfig({ ...validEnv, CDFIR_WORKER_CPU_CONCURRENCY: '1000' })).toThrow();
  });
});

describe('CDFIR_SELF_SERVE_SIGNUP', () => {
  it('stays off unless the operator turns it on', () => {
    expect(loadConfig(validEnv).CDFIR_SELF_SERVE_SIGNUP).toBe(false);
  });

  it('accepts the string a .env file actually supplies', () => {
    expect(
      loadConfig({ ...validEnv, CDFIR_SELF_SERVE_SIGNUP: 'true' }).CDFIR_SELF_SERVE_SIGNUP,
    ).toBe(true);
  });
});
