import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { PrismaClient } from '@evidencevault/database';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MeModule } from './me/me.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CsrfGuard } from './security/csrf.js';
import { PRISMA } from './common/tokens.js';

@Module({
  imports: [CoreModule, HealthModule, AuthModule, MeModule, TenantsModule, AuditModule],
  providers: [
    // Global double-submit CSRF enforcement on every mutating route.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
