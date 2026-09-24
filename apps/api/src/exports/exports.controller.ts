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
import { SkipCsrf } from '../security/skip-csrf.decorator.js';
import {
  ExportsService,
  type ExportDto,
  type CreateExportResult,
  type ExportDownloadResult,
  type ExportDownloadRefreshResult,
} from './exports.service.js';

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
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<CreateExportResult> {
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
  ): Promise<ExportDownloadResult> {
    return this.exports.download(requireAuth(request), id, request);
  }
}

/**
 * URL refresh for a download script, authenticated by a scoped token instead
 * of a session.
 *
 * A SEPARATE controller because it needs different guards. Presigned URLs last
 * five minutes and a 130 GiB export is 65 parts, so a script has to re-sign as
 * it goes — and it cannot do that with a session cookie without a copy of the
 * operator's session sitting in a file on disk. The token reaches exactly one
 * export, read-only, and every use is audited.
 */
@Controller('api/v1/exports')
export class ExportDownloadRefreshController {
  constructor(private readonly exports: ExportsService) {}

  /**
   * The one route in this API outside the global CSRF check.
   *
   * It has to be. The callers are `curl` and PowerShell, which have no cookie
   * jar and so can never produce a matching double-submit pair; before this the
   * first refresh returned `403 CSRF token missing or invalid` and every long
   * download died at the five-minute mark.
   *
   * Sound because the ONLY thing this handler reads for authentication is the
   * Bearer token below. No session guard, no cookie, nothing ambient — so there
   * is nothing a cross-site request could ride in on. Keep it that way: the day
   * this route accepts a session, the exemption has to go with it.
   */
  @Post(':id/download/urls')
  @HttpCode(200)
  @SkipCsrf()
  async refresh(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<ExportDownloadRefreshResult> {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    // Not found rather than unauthorized, and identical for a missing token, a
    // forged one and a real one aimed at another export. Anything finer tells
    // someone probing which half of their guess was right.
    if (token === '') throw new NotFoundException();
    return this.exports.refreshDownloadUrls(token, id, request);
  }
}
