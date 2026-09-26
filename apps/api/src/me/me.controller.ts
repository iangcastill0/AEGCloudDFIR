import { Controller, Get, Inject, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/guards/session.guard.js';

export interface MeResponse {
  user: { id: string; email: string; displayName: string };
  tenant: { id: string; name: string; slug: string } | null;
  roles: string[];
  invited: boolean;
  memberships: Array<{ tenantId: string; tenantName: string; roles: string[] }>;
}

@Controller('api/v1/me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async me(@Req() request: FastifyRequest): Promise<MeResponse> {
    const session = request.cdfirSession;
    if (!session) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) throw new UnauthorizedException('user no longer exists');

    const memberships = await this.authService.listMemberships(session.userId);
    const active = session.tenantId
      ? memberships.find((m) => m.tenantId === session.tenantId)
      : undefined;

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      tenant: active
        ? { id: active.tenant.id, name: active.tenant.name, slug: active.tenant.slug }
        : null,
      roles: active ? active.roles.map((r) => r.role) : [],
      // Active tenant only. "Invited on any membership" let a guest invite on
      // tenant A unlock an unpaid self-serve org on tenant B, and the reverse
      // (invited nowhere) is what the plan wall keys off.
      invited: active?.invited ?? false,
      memberships: memberships.map((m) => ({
        tenantId: m.tenantId,
        tenantName: m.tenant.name,
        roles: m.roles.map((r) => r.role),
      })),
    };
  }
}
