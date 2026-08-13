import { Controller, HttpCode, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { UploadsService, type UploadResult } from './uploads.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/uploads')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(200)
  async upload(@Req() request: FastifyRequest): Promise<UploadResult> {
    return this.uploads.upload(requireAuth(request), request);
  }
}
