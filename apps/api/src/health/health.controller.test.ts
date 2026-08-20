import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { PrismaClient } from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import type { SearchAdapter } from '@aeg-clouddfir/search';
import { HealthController } from './health.controller.js';

const config = { CDFIR_WEB_PUBLIC_URL: 'https://app.example.com' } as AppConfig;
const prisma = {} as PrismaClient;
const store = {} as EvidenceObjectStore;
const search = {} as SearchAdapter;

/** Prisma's $queryRaw is a tagged template; only its resolution matters here. */
function fakePrisma(dbOk: boolean, reason?: unknown): PrismaClient {
  return {
    $queryRaw: () =>
      dbOk ? Promise.resolve([{ 1: 1 }]) : Promise.reject(reason ?? new Error('down')),
  } as unknown as PrismaClient;
}

/** Postgres 42P01 = undefined table, i.e. the migrations were never applied. */
function missingTableError(): Error & { code: string } {
  const err = new Error('relation "tenants" does not exist') as Error & { code: string };
  err.code = '42P01';
  return err;
}
function fakeStore(err?: Error): EvidenceObjectStore {
  return {
    checkReachable: () => (err ? Promise.reject(err) : Promise.resolve()),
  } as unknown as EvidenceObjectStore;
}
function fakeSearch(err?: Error): SearchAdapter {
  return {
    checkReachable: () => (err ? Promise.reject(err) : Promise.resolve()),
  } as unknown as SearchAdapter;
}

describe('HealthController', () => {
  it('liveness reports ok without touching any dependency', () => {
    // prisma is an empty object: if healthz queried anything this would throw,
    // which is the point — liveness must not depend on the database.
    expect(new HealthController(config, prisma, store, search).healthz()).toEqual({ status: 'ok' });
  });

  it('redirects the root path to the configured web app', () => {
    // The apex sends sign-ins through the API host, so a bare 404 at / reads as
    // an outage to anyone who lands there.
    expect(new HealthController(config, prisma, store, search).root()).toEqual({
      url: 'https://app.example.com',
    });
  });

  it('derives the redirect target from config rather than hardcoding a host', () => {
    const other = { CDFIR_WEB_PUBLIC_URL: 'https://review.other.test' } as AppConfig;
    expect(new HealthController(other, prisma, store, search).root().url).toBe(
      'https://review.other.test',
    );
  });
});

describe('HealthController readyz', () => {
  it('reports ok when both the database and object storage answer', async () => {
    const c = new HealthController(config, fakePrisma(true), fakeStore(), fakeSearch());
    await expect(c.readyz()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', objectStorage: 'ok', search: 'ok' },
    });
  });

  // The regression: readyz previously checked only Postgres, so it reported
  // "ok" while the evidence store was completely unauthenticated.
  it('is NOT ok when object storage rejects, even with a healthy database', async () => {
    const err = new Error('bad creds');
    err.name = 'SignatureDoesNotMatch';
    const c = new HealthController(config, fakePrisma(true), fakeStore(err), fakeSearch());
    await expect(c.readyz()).rejects.toMatchObject({
      response: {
        status: 'degraded',
        checks: { database: 'ok', objectStorage: 'unreachable (SignatureDoesNotMatch)' },
      },
    });
  });

  it('names the SDK error so a config fault is distinguishable from an outage', async () => {
    const err = new Error('no bucket');
    err.name = 'NoSuchBucket';
    const c = new HealthController(config, fakePrisma(true), fakeStore(err), fakeSearch());
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { objectStorage: 'unreachable (NoSuchBucket)' } },
    });
  });

  it('reports both dependencies even when both are down', async () => {
    const c = new HealthController(
      config,
      fakePrisma(false),
      fakeStore(new Error('x')),
      fakeSearch(),
    );
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { database: 'unreachable' } },
    });
  });

  // Nothing watched OpenSearch until this was added: /readyz said "ok" while
  // every search could have been failing, and the 5-minute monitor reads this
  // endpoint, so anything missing here is unwatched.
  it('is NOT ok when search rejects, even with a healthy database and storage', async () => {
    const err = new Error('Response Error');
    err.name = 'ResponseError';
    const c = new HealthController(config, fakePrisma(true), fakeStore(), fakeSearch(err));
    await expect(c.readyz()).rejects.toMatchObject({
      response: {
        status: 'degraded',
        checks: { database: 'ok', objectStorage: 'ok', search: 'unreachable (ResponseError)' },
      },
    });
  });

  it('names the search error, so 401 is distinguishable from a dead cluster', async () => {
    const err = new Error('unauthorized');
    err.name = 'AuthenticationException';
    const c = new HealthController(config, fakePrisma(true), fakeStore(), fakeSearch(err));
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { search: 'unreachable (AuthenticationException)' } },
    });
  });

  // Staging ran for an hour with an EMPTY database while readyz reported
  // "database: ok", because the probe was `SELECT 1` — which only proves a
  // socket opened. Logins failed with a 500 that had to be diagnosed from the
  // worker's log.
  it('reports a missing schema distinctly from an unreachable database', async () => {
    const c = new HealthController(
      config,
      fakePrisma(false, missingTableError()),
      fakeStore(),
      fakeSearch(),
    );
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { database: 'schema missing (run migrate:deploy)' } },
    });
  });

  it('still says unreachable when the connection itself fails', async () => {
    const c = new HealthController(config, fakePrisma(false), fakeStore(), fakeSearch());
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { database: 'unreachable' } },
    });
  });

  it('detects 42P01 reported only in the message, as raw queries do', async () => {
    const err = new Error(
      'Raw query failed. Code: `42P01`. Message: `relation ... does not exist`',
    );
    const c = new HealthController(config, fakePrisma(false, err), fakeStore(), fakeSearch());
    await expect(c.readyz()).rejects.toMatchObject({
      response: { checks: { database: 'schema missing (run migrate:deploy)' } },
    });
  });
});
