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
import type {
  CollectionStatusResponse,
  CollectionThroughputResponse,
} from '@aeg-clouddfir/contracts';
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

  /**
   * Measured throughput: per-minute buckets, the two phases, and the state the
   * SERVER decided. `window=history` returns the whole run downsampled;
   * anything else returns the live 60-minute window.
   *
   * `sinceRateLimitWaitMs` is the value the caller's previous response carried.
   * The browser echoes it back untouched and the server compares — that is how
   * "throttling rose since the last poll" is decided in one place only.
   */
  @Get(':id/throughput')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager, TenantRole.reviewer)
  async throughput(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<CollectionThroughputResponse> {
    const since = Number(query['sinceRateLimitWaitMs']);
    return this.collections.throughput(requireAuth(request), id, {
      window: query['window'] === 'history' ? 'history' : 'live',
      ...(Number.isFinite(since) && since >= 0 ? { previousRateLimitWaitMs: since } : {}),
    });
  }

  /**
   * Manifest download. Reviewer and auditor may verify any collection in the
   * tenant. read_only is case-scoped: only a collection filed under a case they
   * are assigned to. The service 404s otherwise — the file names every item.
   */
  @Get(':id/manifest')
  @RequireRoles(
    TenantRole.org_admin,
    TenantRole.case_manager,
    TenantRole.reviewer,
    TenantRole.read_only,
    TenantRole.auditor,
  )
  async manifest(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{
    manifestUrl: string;
    manifestSha256: string;
    completenessReportUrl: string | null;
    expiresInSeconds: number;
  }> {
    return this.collections.manifestDownload(requireAuth(request), id, request);
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
