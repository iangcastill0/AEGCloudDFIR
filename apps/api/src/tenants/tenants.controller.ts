import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantRole, withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createInviteRequest,
  createTenantRequest,
  grantMemberRoleRequest,
} from '@aeg-clouddfir/contracts';
import '../common/http.js';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';
import { parseCursorQuery } from '../common/pagination.js';
import { zodValidate } from '../common/zod-validate.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { deriveSealingKey, writeSessionCookie } from '../auth/session.js';
import { TenantsService } from './tenants.service.js';

export interface MemberListItem {
  membershipId: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
}

@Controller('api/v1/tenants')
@UseGuards(SessionGuard)
export class TenantsController {
  private readonly key: Buffer;
  private readonly isProd: boolean;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsService,
  ) {
    this.key = deriveSealingKey(config.CDFIR_SESSION_SECRET);
    this.isProd = config.NODE_ENV === 'production';
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    const session = request.cdfirSession;
    if (!session) throw new UnauthorizedException();
    const parsed = zodValidate(createTenantRequest, body);
    const created = await this.tenants.createSelfServe(session.userId, parsed, request);
    writeSessionCookie(reply, this.key, { ...session, tenantId: created.tenantId }, this.isProd);
    return created;
  }

  @Get(':tenantId/members')
  @UseGuards(TenantGuard, RolesGuard)
  @RequireRoles(TenantRole.org_admin)
  async members(
    @Param('tenantId') tenantIdParam: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: MemberListItem[]; nextCursor: string | null }> {
    const auth = request.cdfirAuth;
    // Cross-tenant probing is indistinguishable from a missing resource.
    if (!auth || tenantIdParam !== auth.tenantId) {
      throw new NotFoundException();
    }
    const { limit, cursor } = parseCursorQuery(query);

    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.membership.findMany({
        where: { tenantId: auth.tenantId },
        include: {
          user: { select: { email: true, displayName: true } },
          roles: { select: { role: true } },
        },
        orderBy: { id: 'asc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );

    const page = rows.slice(0, limit);
    const items = page.map((m) => ({
      membershipId: m.id,
      email: m.user.email,
      displayName: m.user.displayName,
      status: m.status,
      roles: m.roles.map((r) => r.role),
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? last.id : null };
  }

  @Post(':tenantId/invites')
  @UseGuards(TenantGuard, RolesGuard)
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(201)
  async invite(
    @Param('tenantId') tenantIdParam: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{
    inviteId: string;
    email: string;
    role: TenantRole;
    expiresAt: string;
    inviteUrl: string;
  }> {
    const auth = request.cdfirAuth;
    if (!auth || tenantIdParam !== auth.tenantId) {
      throw new NotFoundException();
    }
    const parsed = zodValidate(createInviteRequest, body);
    const created = await this.tenants.createInvite(auth, parsed, request);
    return {
      inviteId: created.inviteId,
      email: created.email,
      role: created.role,
      expiresAt: created.expiresAt.toISOString(),
      inviteUrl: created.inviteUrl,
    };
  }

  @Post(':tenantId/members/:membershipId/roles')
  @UseGuards(TenantGuard, RolesGuard)
  @RequireRoles(TenantRole.org_admin)
  @HttpCode(200)
  async grantRole(
    @Param('tenantId') tenantIdParam: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ membershipId: string; role: TenantRole; granted: boolean }> {
    const auth = request.cdfirAuth;
    if (!auth || tenantIdParam !== auth.tenantId) {
      throw new NotFoundException();
    }
    const parsed = zodValidate(grantMemberRoleRequest, body);
    return this.tenants.grantMemberRole(auth, membershipId, parsed.role, request);
  }

  @Get(':tenantId/join-link')
  @UseGuards(TenantGuard, RolesGuard)
  @RequireRoles(TenantRole.org_admin)
  async joinLink(
    @Param('tenantId') tenantIdParam: string,
    @Req() request: FastifyRequest,
  ): Promise<{ inviteUrl: string; role: TenantRole }> {
    const auth = request.cdfirAuth;
    if (!auth || tenantIdParam !== auth.tenantId) {
      throw new NotFoundException();
    }
    return this.tenants.getOrCreateJoinLink(auth);
  }

  @Post(':tenantId/join-link/rotate')
  @UseGuards(TenantGuard, RolesGuard)
  @RequireRoles(TenantRole.org_admin)
  async rotateJoinLink(
    @Param('tenantId') tenantIdParam: string,
    @Req() request: FastifyRequest,
  ): Promise<{ inviteUrl: string; role: TenantRole }> {
    const auth = request.cdfirAuth;
    if (!auth || tenantIdParam !== auth.tenantId) {
      throw new NotFoundException();
    }
    return this.tenants.rotateJoinLink(auth, request);
  }
}
