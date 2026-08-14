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
import { CasesService, type CaseDto } from './cases.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/cases')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Post()
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<CaseDto> {
    return this.cases.create(requireAuth(request), body, request);
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
  ): Promise<{ items: CaseDto[]; nextCursor: string | null }> {
    return this.cases.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
  )
  async get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<CaseDto> {
    return this.cases.get(requireAuth(request), id);
  }

  @Put(':id')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CaseDto> {
    return this.cases.update(requireAuth(request), id, body, request);
  }

  @Post(':id/items')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  @HttpCode(200)
  async addItems(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ requested: number; added: number }> {
    return this.cases.addItems(requireAuth(request), id, body, request);
  }

  @Get(':id/items')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
  )
  async items(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: { id: string; evidenceItemId: string; name: string; kind: string; addedVia: string }[];
    nextCursor: string | null;
  }> {
    return this.cases.items(requireAuth(request), id, parseCursorQuery(query));
  }

  /** Read-only roles included: seeing who has access to a matter is a read. */
  @Get(':id/members')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
  )
  async members(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: { membershipId: string; email: string; displayName: string; roles: string[] }[];
    nextCursor: string | null;
  }> {
    return this.cases.members(requireAuth(request), id, parseCursorQuery(query));
  }

  /**
   * Tags present on this case's items — used by the production wizard so a
   * reviewer can only select tags that actually appear in the matter.
   */
  @Get(':id/tags')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
    TenantRole.production_manager,
  )
  async tags(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{ items: { id: string; name: string; color: string; itemCount: number }[] }> {
    return this.cases.tags(requireAuth(request), id);
  }

  @Get(':id/notes')
  @RequireRoles(
    TenantRole.case_manager,
    TenantRole.org_admin,
    TenantRole.reviewer,
    TenantRole.read_only,
  )
  async notes(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: { id: string; authorDisplay: string; text: string; createdAt: string }[];
    nextCursor: string | null;
  }> {
    return this.cases.notes(requireAuth(request), id, parseCursorQuery(query));
  }

  /** Writing a note is a review activity, so reviewers may do it. */
  @Post(':id/notes')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin, TenantRole.reviewer)
  @HttpCode(200)
  async addNote(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; authorDisplay: string; text: string; createdAt: string }> {
    return this.cases.addNote(requireAuth(request), id, body, request);
  }

  @Post(':id/members')
  @RequireRoles(TenantRole.case_manager)
  @HttpCode(200)
  async addMember(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    return this.cases.addMember(requireAuth(request), id, body, request);
  }

  @Delete(':id/members/:membershipId')
  @RequireRoles(TenantRole.case_manager)
  @HttpCode(200)
  async removeMember(
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    return this.cases.removeMember(requireAuth(request), id, membershipId, request);
  }

  @Put(':id/hold')
  @RequireRoles(TenantRole.case_manager, TenantRole.org_admin)
  async hold(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CaseDto> {
    return this.cases.setHold(requireAuth(request), id, body, request);
  }
}
