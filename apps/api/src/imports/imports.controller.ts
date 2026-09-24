import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import {
  importSearchQuery,
  type ImportArtifact,
  type ImportSearchHit,
  type ImportSummary,
} from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../common/http.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { zodValidate } from '../common/zod-validate.js';
import { ImportsService } from './imports.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

const READ_ROLES = [
  TenantRole.org_admin,
  TenantRole.case_manager,
  TenantRole.reviewer,
  TenantRole.read_only,
  TenantRole.production_manager,
] as const;

@Controller('api/v1/imports')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(201)
  async upload(@Req() request: FastifyRequest): Promise<ImportSummary> {
    return this.imports.upload(requireAuth(request), request);
  }

  @Get()
  @RequireRoles(...READ_ROLES)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ImportSummary[]; nextCursor: string | null }> {
    return this.imports.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  @RequireRoles(...READ_ROLES)
  async detail(@Param('id') id: string, @Req() request: FastifyRequest): Promise<ImportSummary> {
    return this.imports.detail(requireAuth(request), id);
  }

  @Get(':id/artifacts')
  @RequireRoles(...READ_ROLES)
  async artifacts(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ImportArtifact[]; nextCursor: string | null }> {
    return this.imports.artifacts(requireAuth(request), id, parseCursorQuery(query));
  }

  @Get(':id/search')
  @RequireRoles(...READ_ROLES)
  async search(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ImportSearchHit[]; nextCursor: string | null }> {
    return this.imports.search(requireAuth(request), id, zodValidate(importSearchQuery, query));
  }

  @Get(':id/artifacts/:artifactId')
  @RequireRoles(...READ_ROLES)
  async artifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Req() request: FastifyRequest,
  ): Promise<ImportArtifact> {
    return this.imports.artifact(requireAuth(request), id, artifactId);
  }

  @Post(':id/retry')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(200)
  async retry(@Param('id') id: string, @Req() request: FastifyRequest): Promise<ImportSummary> {
    return this.imports.retry(requireAuth(request), id, request);
  }

  @Post(':id/cases')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(200)
  async attach(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ importId: string; caseId: string; itemsAdded: number }> {
    return this.imports.attach(requireAuth(request), id, body, request);
  }
}
