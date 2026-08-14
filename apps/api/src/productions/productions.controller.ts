import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { ProductionsService, type ProductionDto, type ProductionRunDto } from './productions.service.js';
import type { ValidationFlag } from './production.validator.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/productions')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class ProductionsController {
  constructor(private readonly productions: ProductionsService) {}

  @Post()
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; status: string; replayed: boolean }> {
    return this.productions.create(requireAuth(request), body, request);
  }

  @Get()
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ProductionDto[]; nextCursor: string | null }> {
    return this.productions.list(requireAuth(request), parseCursorQuery(query));
  }

  @Get(':id')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async get(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<ProductionDto & { parameters: unknown; runs: ProductionRunDto[] }> {
    return this.productions.get(requireAuth(request), id);
  }

  @Put(':id')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ProductionDto> {
    return this.productions.update(requireAuth(request), id, body, request);
  }

  @Post(':id/validate')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  @HttpCode(200)
  async validate(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{
    draftCalculatedAt: string;
    itemCount: number;
    estimatedPageCount: number | null;
    flags: ValidationFlag[];
    canSubmit: boolean;
  }> {
    return this.productions.validate(requireAuth(request), id, request);
  }

  @Post(':id/submit')
  @RequireRoles(TenantRole.production_manager)
  @HttpCode(200)
  async submit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{
    productionId: string;
    runId: string;
    runNumber: number;
    batesStart: string;
    batesEnd: string;
  }> {
    return this.productions.submit(requireAuth(request), id, body, request);
  }

  @Get(':id/runs/:runId')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async getRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Req() request: FastifyRequest,
  ): Promise<ProductionRunDto> {
    return this.productions.getRun(requireAuth(request), id, runId);
  }

  /**
   * Download a completed production run. Restricted to the roles that own
   * production work — this is the disclosure artifact leaving the platform, and
   * the request is audited as production.run_downloaded.
   */
  @Get(':id/exceptions')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async exceptions(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{
    items: {
      id: string;
      kind: string;
      message: string;
      itemRef: string | null;
      evidenceItemId: string | null;
      severity: string;
      overridden: boolean;
      occurredAt: string;
    }[];
    nextCursor: string | null;
  }> {
    return this.productions.exceptions(requireAuth(request), id, parseCursorQuery(query));
  }

  @Get(':id/runs/:runId/download')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async downloadRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Req() request: FastifyRequest,
  ): Promise<{
    files: { path: string; url: string; sizeBytes: number }[];
    manifestSha256: string;
    expiresInSeconds: number;
  }> {
    return this.productions.downloadRun(requireAuth(request), id, runId, request);
  }

  /**
   * The whole run as one zip, extracting into a single folder.
   *
   * Streamed rather than assembled: a production can be tens of gigabytes, and
   * neither this process nor storage should hold a copy to hand one out. The
   * plan is resolved first so that every legitimate refusal — wrong tenant,
   * unfinished run, output already swept by retention — is still a JSON error;
   * after the first byte the only signal left is a broken stream.
   */
  @Get(':id/runs/:runId/archive')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  async archiveRun(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const auth = requireAuth(request);
    const plan = await this.productions.prepareRunArchive(auth, id, runId);

    const body = new PassThrough();
    // Send before writing: the archive is produced as it is consumed, so
    // filling the stream first would just stall on backpressure.
    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${plan.fileName}"`)
      .header('cache-control', 'no-store')
      .send(body);

    try {
      await this.productions.streamRunArchive(auth, plan, body, request);
    } catch (err) {
      // The status line is long gone, so destroy the body: the client sees a
      // truncated transfer and a zip with no central directory, rather than a
      // 200 with a set that is quietly missing documents.
      body.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  @Post(':id/runs/:runId/clone')
  @RequireRoles(TenantRole.production_manager, TenantRole.case_manager)
  @HttpCode(200)
  async clone(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; status: string }> {
    return this.productions.cloneRun(requireAuth(request), id, runId, request);
  }
}
