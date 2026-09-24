import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OidcService } from './oidc.service.js';

@Module({
  imports: [AuditModule, TenantsModule],
  providers: [AuthService, OidcService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
