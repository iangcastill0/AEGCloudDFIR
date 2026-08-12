import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantRole, withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';

export interface MemberListItem {
  membershipId: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
}

@Controller('api/v1/tenants')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
export class TenantsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get(':tenantId/members')
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
}
