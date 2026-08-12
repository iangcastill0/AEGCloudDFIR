import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { PrismaClient } from '@aeg-clouddfir/database';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

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
