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
import type { CollectionStatusResponse } from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { CollectionsService, type CollectionListItem } from './collections.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/collections')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post()
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; status: string; replayed: boolean }> {
    return this.collections.create(requireAuth(request), body, request);
  }

  @Get()
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager, TenantRole.reviewer)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: CollectionListItem[]; nextCursor: string | null }> {
    return this.collections.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager, TenantRole.reviewer)
  async detail(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<CollectionStatusResponse> {
    return this.collections.status(requireAuth(request), id);
  }

  @Get(':id/exceptions')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager, TenantRole.reviewer)
  async exceptions(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: { id: string; kind: string; message: string; itemRef: string | null }[];
    nextCursor: string | null;
  }> {
    const { cursor, limit } = parseCursorQuery(query);
    const kind =
      typeof query['kind'] === 'string' && query['kind'] !== '' ? query['kind'] : undefined;
    return this.collections.exceptions(requireAuth(request), id, { cursor, limit, kind });
  }

  @Get(':id/status')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager, TenantRole.reviewer)
  async status(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<CollectionStatusResponse> {
    return this.collections.status(requireAuth(request), id);
  }

  @Post(':id/:action')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  @HttpCode(200)
  async action(
    @Param('id') id: string,
    @Param('action') action: string,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; status: string; retriedItems?: number }> {
    return this.collections.action(requireAuth(request), id, action, request);
  }
}
