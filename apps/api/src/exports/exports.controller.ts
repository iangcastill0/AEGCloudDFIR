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
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { ExportsService, type ExportDto } from './exports.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/exports')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
@RequireRoles(TenantRole.case_manager)
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; status: string; itemCount: number; replayed: boolean }> {
    return this.exports.create(requireAuth(request), body, request);
  }

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ExportDto[]; nextCursor: string | null }> {
    return this.exports.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<ExportDto> {
    return this.exports.get(requireAuth(request), id);
  }

  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{
    manifestUrl: string;
    archiveUrls: string[];
    manifestSha256: string;
    expiresInSeconds: number;
  }> {
    return this.exports.download(requireAuth(request), id, request);
  }
}
