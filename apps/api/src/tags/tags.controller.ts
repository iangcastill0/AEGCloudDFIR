import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
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
import { TagsService, type TagDto } from './tags.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/tags')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Post()
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<TagDto> {
    return this.tags.create(requireAuth(request), body, request);
  }

  @Get()
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
  )
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: TagDto[]; nextCursor: string | null }> {
    return this.tags.list(requireAuth(request), parseCursorQuery(query));
  }

  @Put(':id')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<TagDto> {
    return this.tags.update(requireAuth(request), id, body, request);
  }

  @Delete(':id')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  @HttpCode(200)
  async remove(
    @Param('id') id: string,
    @Query('force') force: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true; assignmentsRemoved: number }> {
    return this.tags.remove(requireAuth(request), id, force === '1', request);
  }

  @Post('bulk')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer)
  @HttpCode(200)
  async bulk(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ action: string; requested: number; expanded: number; affected: number }> {
    return this.tags.bulk(requireAuth(request), body, request);
  }
}
