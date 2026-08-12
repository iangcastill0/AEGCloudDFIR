import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import { Provider, TenantRole } from '@aeg-clouddfir/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG } from '../common/tokens.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { Public } from '../auth/guards/public.decorator.js';
import { CONNECTOR_FLOW_COOKIE } from '../auth/session.js';
import { ConnectorsService, type ConnectorDto, type CustodianDto } from './connectors.service.js';

function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.cdfirAuth;
  if (!auth) throw new NotFoundException();
  return auth;
}

@Controller('api/v1/connectors')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class ConnectorsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly connectors: ConnectorsService,
  ) {}

  @Get()
  @RequireRoles(TenantRole.org_admin)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: ConnectorDto[]; nextCursor: string | null }> {
    return this.connectors.list(requireAuth(request), parseCursorQuery(query));
  }

  @Post()
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ connector: ConnectorDto; authorizationUrl?: string }> {
    const result = await this.connectors.create(requireAuth(request), body, request);
    if (result.flowCookie) {
      reply.setCookie(CONNECTOR_FLOW_COOKIE, result.flowCookie.value, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.NODE_ENV === 'production',
        maxAge: result.flowCookie.maxAge,
      });
    }
    return {
      connector: result.connector,
      ...(result.authorizationUrl !== undefined
        ? { authorizationUrl: result.authorizationUrl }
        : {}),
    };
  }

  @Post(':id/org')
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(200)
  async configureOrg(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true; adminConsentUrl?: string; auditScopes?: string[] }> {
    return this.connectors.configureOrg(requireAuth(request), id, body, request);
  }

  @Post(':id/test')
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(200)
  async test(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: boolean; detail: string }> {
    return this.connectors.test(requireAuth(request), id, request);
  }

  @Get(':id/custodians')
  @RequireRoles(TenantRole.org_admin, TenantRole.case_manager)
  async custodians(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: CustodianDto[]; nextCursor: string | null; notice?: string }> {
    const search = typeof query.search === 'string' ? query.search : undefined;
    const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
    return this.connectors.custodians(requireAuth(request), id, { search, cursor });
  }

  @Delete(':id')
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(200)
  async revoke(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true; providerRevocationNote: string }> {
    return this.connectors.revoke(requireAuth(request), id, request);
  }
}

/**
 * Provider OAuth callbacks. Public: the browser arrives from the provider,
 * authenticated by the sealed, cookie-bound state value instead of a session.
 */
@Controller('api/v1/connectors/callback')
@UseGuards(SessionGuard)
@Public()
export class ConnectorsCallbackController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('microsoft')
  async microsoft(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { redirectUrl } = await this.connectors.completeCallback(
      Provider.microsoft,
      query,
      request.cookies ?? {},
    );
    reply.clearCookie(CONNECTOR_FLOW_COOKIE, { path: '/' });
    reply.redirect(302, redirectUrl);
  }

  @Get('google')
  async google(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { redirectUrl } = await this.connectors.completeCallback(
      Provider.google,
      query,
      request.cookies ?? {},
    );
    reply.clearCookie(CONNECTOR_FLOW_COOKIE, { path: '/' });
    reply.redirect(302, redirectUrl);
  }
}
