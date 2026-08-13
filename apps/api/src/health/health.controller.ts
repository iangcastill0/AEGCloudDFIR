import { Controller, Get, Inject, Redirect, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { PrismaClient } from '@aeg-clouddfir/database';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
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
  @Get('readyz')
  async readyz(): Promise<{ status: 'ok'; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'unreachable';
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return { status: 'ok', checks };
  }
}
