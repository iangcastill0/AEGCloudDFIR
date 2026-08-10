import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { withTenantContext, type PrismaClient } from '@evidencevault/database';
import type { FastifyRequest } from 'fastify';
import '../../common/http.js';
import { PRISMA } from '../../common/tokens.js';

/**
 * Requires an active tenant selection on the session, verifies the caller's
 * membership inside the tenant's RLS context, and attaches request.evAuth.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const session = request.evSession;
    if (!session) throw new UnauthorizedException('authentication required');
    const tenantId = session.tenantId;
    if (!tenantId) throw new ForbiddenException('no tenant selected');

    // users table has no RLS; membership + roles are read inside tenant context.
    const [user, membership] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { isPlatformAdmin: true, displayName: true, email: true },
      }),
      withTenantContext(this.prisma, tenantId, (tx) =>
        tx.membership.findUnique({
          where: { tenantId_userId: { tenantId, userId: session.userId } },
          include: { roles: { select: { role: true } } },
        }),
      ),
    ]);

    if (!user || !membership || membership.status !== 'active') {
      throw new ForbiddenException('not an active member of this tenant');
    }

    request.evAuth = {
      userId: session.userId,
      tenantId,
      membershipId: membership.id,
      roles: membership.roles.map((r) => r.role),
      isPlatformAdmin: user.isPlatformAdmin,
      actorDisplay: user.displayName.length > 0 ? user.displayName : user.email,
    };
    return true;
  }
}
