import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { PrismaClient } from '@aeg-clouddfir/database';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MeModule } from './me/me.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { AuditModule } from './audit/audit.module.js';
import { KeyEncryptionModule } from './common/key-encryption.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { CollectionsModule } from './collections/collections.module.js';
import { SearchModule } from './search/search.module.js';
import { EvidenceModule } from './evidence/evidence.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { TagsModule } from './tags/tags.module.js';
import { CasesModule } from './cases/cases.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { ProductionsModule } from './productions/productions.module.js';
import { CsrfGuard } from './security/csrf.js';
import { PRISMA } from './common/tokens.js';

@Module({
  imports: [
    CoreModule,
    KeyEncryptionModule,
    HealthModule,
    AuthModule,
    MeModule,
    TenantsModule,
    AuditModule,
    ConnectorsModule,
    CollectionsModule,
    SearchModule,
    EvidenceModule,
    UploadsModule,
    TagsModule,
    CasesModule,
    ExportsModule,
    ProductionsModule,
  ],
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
