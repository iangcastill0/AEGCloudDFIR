import { Controller, Get, Inject, Redirect, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { PrismaClient } from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import type { SearchAdapter } from '@aeg-clouddfir/search';
import { APP_CONFIG, PRISMA, EVIDENCE_STORE, SEARCH_ADAPTER } from '../common/tokens.js';

/**
 * True when the failure is "that table does not exist" rather than a connection
 * problem. Postgres reports 42P01; Prisma exposes it as `code` and also includes
 * it in the message for raw queries.
 */
function isMissingSchema(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const err = reason as { code?: unknown; message?: unknown };
  if (err.code === '42P01') return true;
  return typeof err.message === 'string' && err.message.includes('42P01');
}

@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVIDENCE_STORE) private readonly evidenceStore: EvidenceObjectStore,
    @Inject(SEARCH_ADAPTER) private readonly search: SearchAdapter,
  ) {}

  /**
   * The API host is a user-visible entry point — the apex redirects sign-ins
   * through it — so a bare 404 here reads as an outage to anyone who lands on
   * it. Send them to the web app instead. Deliberately 302: this is a
   * convenience for humans, not a permanent relocation of the API, and a cached
   * 301 on an API origin would be difficult to walk back.
   *
   * Only the root path. Every other unmatched route still 404s, because a
   * catch-all redirect would turn a typo'd or removed endpoint into an HTML
   * page and hide real routing mistakes from clients.
   */
  @Get()
  @Redirect('', 302)
  root(): { url: string } {
    return { url: this.config.CDFIR_WEB_PUBLIC_URL };
  }

  /** Liveness: the process is up. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Startup: the app finished bootstrapping (route table is live). */
  @Get('startupz')
  startupz(): { status: 'ok'; version: string } {
    return { status: 'ok', version: this.config.CDFIR_APP_VERSION };
  }

  /** Readiness: dependencies reachable; 503 with per-check detail otherwise. */
  /**
   * Readiness: every dependency the API cannot serve its purpose without.
   *
   * Object storage is checked here, not just the database. An API that cannot
   * authenticate to the evidence store can accept a collection and then fail
   * every write, so reporting "ok" in that state is a lie — and exactly the
   * misconfiguration this probe missed when it only checked Postgres (the S3
   * secret sat at its placeholder value while the store was unreachable).
   *
   * Both checks are reported before either can throw, so a caller sees which
   * dependency is at fault rather than only the first one to fail.
   */
  @Get('readyz')
  async readyz(): Promise<{ status: 'ok'; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};

    const results = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1 FROM tenants LIMIT 1`,
      this.evidenceStore.checkReachable(),
      this.search.checkReachable(),
    ]);
    const [db, storage, search] = results;
    checks['database'] =
      db.status === 'fulfilled'
        ? 'ok'
        : // `SELECT 1` only proves a socket opened. Querying a real table means
          // an unmigrated database FAILS instead of reporting ok — staging ran
          // with zero tables while this said "database: ok", and the login 500
          // it caused had to be diagnosed from the worker's log instead.
          isMissingSchema(db.reason)
          ? 'schema missing (run migrate:deploy)'
          : 'unreachable';
    checks['objectStorage'] =
      storage.status === 'fulfilled'
        ? 'ok'
        : // Name the SDK error: SignatureDoesNotMatch means wrong credentials,
          // NoSuchBucket means wrong bucket or region. Both are config errors a
          // generic "unreachable" would send you looking in the wrong place for.
          `unreachable (${storage.reason instanceof Error ? storage.reason.name : 'unknown'})`;

    checks['search'] =
      search.status === 'fulfilled'
        ? 'ok'
        : // 401/AuthenticationException means the password is wrong; a connection
          // error means the cluster is down. Both look identical in a boolean.
          `unreachable (${search.reason instanceof Error ? search.reason.name : 'unknown'})`;

    if (db.status === 'rejected' || storage.status === 'rejected' || search.status === 'rejected') {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }
}
