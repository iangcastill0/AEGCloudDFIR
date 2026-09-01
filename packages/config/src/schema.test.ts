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
    expect(config.CDFIR_MAX_ARCHIVE_DEPTH).toBe(3);
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
