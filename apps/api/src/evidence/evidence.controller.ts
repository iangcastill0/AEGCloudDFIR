import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { TenantRole } from '@evidencevault/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { EvidenceService, type EvidenceDetailDto } from './evidence.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.evAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/evidence')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Get(':id')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  async detail(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<EvidenceDetailDto> {
    return this.evidence.detail(requireAuth(request), id);
  }

  @Get(':id/headers')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  async headers(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{ items: { name: string; rawName: string; value: string; position: number }[] }> {
    return this.evidence.headers(requireAuth(request), id);
  }

  @Get(':id/family')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  async family(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): ReturnType<EvidenceService['family']> {
    return this.evidence.family(requireAuth(request), id);
  }

  @Get(':id/chain')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  async chain(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): ReturnType<EvidenceService['chain']> {
    return this.evidence.chain(requireAuth(request), id);
  }

  @Get(':id/preview')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  async preview(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: { kind: string; mimeType: string; pageCount: number; url: string }[];
    note: string;
  }> {
    return this.evidence.preview(requireAuth(request), id);
  }

  @Get(':id/native')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.reviewer,
    TenantRole.read_only,
    TenantRole.org_admin,
  )
  async native(
    @Param('id') id: string,
    @Query('confirmDangerous') confirmDangerous: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<{ url: string; name: string; sha256: string; expiresInSeconds: number }> {
    return this.evidence.native(requireAuth(request), id, confirmDangerous === '1', request);
  }
}
