import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from './schema.js';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  EV_API_PUBLIC_URL: 'http://localhost:4000',
  EV_WEB_PUBLIC_URL: 'http://localhost:3000',
  EV_DATABASE_URL: 'postgresql://ev:pw@localhost:5432/ev',
  EV_REDIS_URL: 'redis://localhost:6379',
  EV_OPENSEARCH_URL: 'http://localhost:9200',
  EV_S3_ENDPOINT: 'http://localhost:9000',
  EV_S3_REGION: 'us-east-1',
  EV_S3_BUCKET_EVIDENCE: 'ev-evidence',
  EV_S3_BUCKET_QUARANTINE: 'ev-quarantine',
  EV_S3_ACCESS_KEY_ID: 'minioadmin',
  EV_S3_SECRET_ACCESS_KEY: 'a-secret-value',
  EV_OIDC_ISSUER: 'http://localhost:9443/application/o/evidencevault/',
  EV_OIDC_CLIENT_ID: 'evidencevault',
  EV_OIDC_CLIENT_SECRET: 'an-oidc-secret',
  EV_SESSION_SECRET: 'x'.repeat(48),
  EV_KEK_LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  it('accepts a complete valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.EV_API_PORT).toBe(4000);
    expect(config.EV_S3_PRESIGN_TTL_SECONDS).toBe(300);
    expect(config.EV_DEMO_MODE).toBe(false);
    expect(config.EV_MAX_ARCHIVE_DEPTH).toBe(3);
    expect(config.EV_CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('parses comma-separated CORS origins', () => {
    const config = loadConfig({
      ...validEnv,
      EV_CORS_ALLOWED_ORIGINS: 'http://a.example, http://b.example',
    });
    expect(config.EV_CORS_ALLOWED_ORIGINS).toEqual(['http://a.example', 'http://b.example']);
  });

  it('fails fast with key-level messages and no secret values', () => {
    const env = { ...validEnv };
    delete env.EV_DATABASE_URL;
    env.EV_S3_ENDPOINT = 'not-a-url';
    try {
      loadConfig(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('EV_DATABASE_URL');
      expect(message).toContain('EV_S3_ENDPOINT');
      // secret values from the env must never appear in the error text
      expect(message).not.toContain('a-secret-value');
      expect(message).not.toContain('an-oidc-secret');
    }
  });

  it('rejects demo mode in production', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production', EV_DEMO_MODE: 'true' })).toThrow(
      /EV_DEMO_MODE/,
    );
  });

  it('rejects out-of-range presign TTL', () => {
    expect(() => loadConfig({ ...validEnv, EV_S3_PRESIGN_TTL_SECONDS: '86400' })).toThrow(
      /EV_S3_PRESIGN_TTL_SECONDS/,
    );
  });

  it('redactConfig elides every secret key', () => {
    const redacted = redactConfig(loadConfig(validEnv));
    expect(redacted.EV_DATABASE_URL).toBe('[redacted]');
    expect(redacted.EV_S3_SECRET_ACCESS_KEY).toBe('[redacted]');
    expect(redacted.EV_OIDC_CLIENT_SECRET).toBe('[redacted]');
    expect(redacted.EV_SESSION_SECRET).toBe('[redacted]');
    expect(redacted.EV_KEK_LOCAL_MASTER_KEY).toBe('[redacted]');
    expect(redacted.EV_API_PORT).toBe(4000);
  });
});
