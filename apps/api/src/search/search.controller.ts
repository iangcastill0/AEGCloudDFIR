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
import { SearchService, type ExplainResultDto, type SearchResultDto } from './search.service.js';
import { SavedSearchesService, type SavedSearchDto } from './saved-searches.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/search')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  @HttpCode(200)
  async execute(@Body() body: unknown, @Req() request: FastifyRequest): Promise<SearchResultDto> {
    return this.search.execute(requireAuth(request), body, request);
  }

  @Post('explain')
  @RequireRoles(TenantRole.case_manager, TenantRole.reviewer, TenantRole.read_only)
  @HttpCode(200)
  async explain(@Body() body: unknown, @Req() request: FastifyRequest): Promise<ExplainResultDto> {
    return this.search.explain(requireAuth(request), body);
  }
}

@Controller('api/v1/saved-searches')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
@RequireRoles(TenantRole.case_manager, TenantRole.reviewer)
export class SavedSearchesController {
  constructor(private readonly savedSearches: SavedSearchesService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: FastifyRequest): Promise<SavedSearchDto> {
    return this.savedSearches.create(requireAuth(request), body, request);
  }

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: SavedSearchDto[]; nextCursor: string | null }> {
    return this.savedSearches.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<SavedSearchDto> {
    return this.savedSearches.get(requireAuth(request), id);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<SavedSearchDto> {
    return this.savedSearches.update(requireAuth(request), id, body, request);
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Req() request: FastifyRequest): Promise<{ ok: true }> {
    return this.savedSearches.remove(requireAuth(request), id, request);
  }
}
