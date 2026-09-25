import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BillingStatus,
  MembershipStatus,
  Prisma,
  TenantRole,
  withTenantContext,
  type PrismaClient,
} from '@aeg-clouddfir/database';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG, PRISMA } from '../common/tokens.js';
import { QUOTA_DEFAULTS } from '../common/quotas.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/http.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';
import { normalizeTenantSlug, tenantSlugError } from './tenant-slug.js';

const LOCAL_SOURCE = 'local';
const TENANT_CREATE_COOLDOWN_MS = 15 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STANDING_JOIN_ROLE = TenantRole.reviewer;

function signupInviteUrl(webPublicUrl: string, token: string): string {
  return `${webPublicUrl}/signup?token=${encodeURIComponent(token)}`;
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  canCreateTenant(): boolean {
    return this.config.CDFIR_SELF_SERVE_SIGNUP;
  }

  async createSelfServe(
    userId: string,
    input: { name: string; slug: string },
    request?: FastifyRequest,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    if (!this.config.CDFIR_SELF_SERVE_SIGNUP) {
      throw new ForbiddenException('self-serve sign-up is not enabled');
    }

    const slug = normalizeTenantSlug(input.slug);
    const slugProblem = tenantSlugError(slug);
    if (slugProblem) throw new BadRequestException(slugProblem);
    const name = input.name.trim();
    if (name.length === 0) throw new BadRequestException('name is required');

    const cutoff = new Date(Date.now() - TENANT_CREATE_COOLDOWN_MS);
    const recentCreates = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx.membership.count({
        where: {
          userId,
          roles: { some: { role: TenantRole.org_admin } },
          tenant: { createdAt: { gte: cutoff } },
        },
      });
    });
    if (recentCreates > 0) {
      throw new HttpException(
        'wait a few minutes before creating another organization',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const tenant = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
        const created = await tx.tenant.create({
          data: {
            name,
            slug,
            billingStatus: BillingStatus.none,
            planQuota: { ...QUOTA_DEFAULTS },
            joinToken: generateInviteToken(),
          },
          select: { id: true, name: true, slug: true },
        });
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${created.id}, true)`;
        const membership = await tx.membership.create({
          data: { tenantId: created.id, userId, status: MembershipStatus.active },
          select: { id: true },
        });
        await tx.roleAssignment.create({
          data: {
            tenantId: created.id,
            membershipId: membership.id,
            role: TenantRole.org_admin,
            source: LOCAL_SOURCE,
          },
        });
        await this.audit.appendTx(tx, {
          tenantId: created.id,
          actorUserId: userId,
          effectiveRoles: [TenantRole.org_admin],
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: created.id,
          summary: { slug, name, selfServe: true },
          request,
        });
        await this.audit.appendTx(tx, {
          tenantId: created.id,
          actorUserId: userId,
          effectiveRoles: [TenantRole.org_admin],
          action: 'tenant.member_joined',
          targetType: 'user',
          targetId: userId,
          summary: { role: TenantRole.org_admin, via: 'self_serve_create' },
          request,
        });
        return created;
      });
      return { tenantId: tenant.id, name: tenant.name, slug: tenant.slug };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('that slug is already in use');
      }
      throw err;
    }
  }

  async createInvite(
    auth: AuthContext,
    input: { email: string; role: TenantRole },
    request?: FastifyRequest,
  ): Promise<{
    inviteId: string;
    email: string;
    role: TenantRole;
    expiresAt: Date;
    inviteUrl: string;
  }> {
    const email = input.email.trim().toLowerCase();
    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const created = await tx.tenantInvite.create({
        data: {
          tenantId: auth.tenantId,
          email,
          role: input.role,
          tokenHash,
          expiresAt,
          createdByUserId: auth.userId,
        },
        select: { id: true, email: true, role: true, expiresAt: true },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        effectiveRoles: auth.roles,
        action: 'tenant.invite_created',
        targetType: 'tenant_invite',
        targetId: created.id,
        summary: { email, role: input.role },
        request,
      });
      return created;
    });

    const inviteUrl = signupInviteUrl(this.config.CDFIR_WEB_PUBLIC_URL, token);
    return {
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      inviteUrl,
    };
  }

  async getOrCreateJoinLink(auth: AuthContext): Promise<{ inviteUrl: string; role: TenantRole }> {
    const token = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { joinToken: true },
      });
      if (tenant?.joinToken) return tenant.joinToken;
      const minted = generateInviteToken();
      await tx.tenant.update({
        where: { id: auth.tenantId },
        data: { joinToken: minted },
      });
      return minted;
    });
    return {
      inviteUrl: signupInviteUrl(this.config.CDFIR_WEB_PUBLIC_URL, token),
      role: STANDING_JOIN_ROLE,
    };
  }

  async rotateJoinLink(
    auth: AuthContext,
    request?: FastifyRequest,
  ): Promise<{ inviteUrl: string; role: TenantRole }> {
    const token = generateInviteToken();
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await tx.tenant.update({
        where: { id: auth.tenantId },
        data: { joinToken: token },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        effectiveRoles: auth.roles,
        action: 'tenant.join_link_rotated',
        targetType: 'tenant',
        targetId: auth.tenantId,
        request,
      });
    });
    return {
      inviteUrl: signupInviteUrl(this.config.CDFIR_WEB_PUBLIC_URL, token),
      role: STANDING_JOIN_ROLE,
    };
  }

  async redeemInvite(
    userId: string,
    token: string,
    request?: FastifyRequest,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    const tokenHash = hashInviteToken(token);
    const invite = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.invite_token_hash', ${tokenHash}, true)`;
      return tx.tenantInvite.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          tenantId: true,
          email: true,
          role: true,
          expiresAt: true,
          usedAt: true,
        },
      });
    });
    if (invite) {
      if (invite.usedAt || invite.expiresAt.getTime() <= Date.now()) {
        throw new NotFoundException('invite is not valid');
      }
      return this.redeemOneTimeInvite(userId, invite, request);
    }
    return this.redeemStandingJoin(userId, token, request);
  }

  private async redeemOneTimeInvite(
    userId: string,
    invite: {
      id: string;
      tenantId: string;
      email: string;
      role: TenantRole;
    },
    request?: FastifyRequest,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) throw new ForbiddenException('user no longer exists');
    if (user.email.trim().toLowerCase() !== invite.email) {
      throw new ForbiddenException('this invite was sent to a different email address');
    }

    return withTenantContext(this.prisma, invite.tenantId, async (tx) => {
      const tenant = await this.requireActiveTenant(tx, invite.tenantId);
      await this.ensureMembership(tx, tenant.id, userId, invite.role, true);
      await tx.tenantInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });
      await this.audit.appendTx(tx, {
        tenantId: tenant.id,
        actorUserId: userId,
        effectiveRoles: [invite.role],
        action: 'tenant.member_joined',
        targetType: 'user',
        targetId: userId,
        summary: { via: 'invite', inviteId: invite.id, role: invite.role },
        request,
      });
      return { tenantId: tenant.id, name: tenant.name, slug: tenant.slug };
    });
  }

  private async redeemStandingJoin(
    userId: string,
    token: string,
    request?: FastifyRequest,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    const found = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.join_token', ${token}, true)`;
      return tx.tenant.findFirst({
        where: { joinToken: token },
        select: { id: true, name: true, slug: true, status: true },
      });
    });
    if (!found) throw new NotFoundException('invite is not valid');
    if (found.status !== 'active') {
      throw new ForbiddenException('this organization is not active');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new ForbiddenException('user no longer exists');

    return withTenantContext(this.prisma, found.id, async (tx) => {
      await this.ensureMembership(tx, found.id, userId, STANDING_JOIN_ROLE, true);
      await this.audit.appendTx(tx, {
        tenantId: found.id,
        actorUserId: userId,
        effectiveRoles: [STANDING_JOIN_ROLE],
        action: 'tenant.member_joined',
        targetType: 'user',
        targetId: userId,
        summary: { via: 'join_link', role: STANDING_JOIN_ROLE },
        request,
      });
      return { tenantId: found.id, name: found.name, slug: found.slug };
    });
  }

  private async requireActiveTenant(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<{ id: string; name: string; slug: string }> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new ForbiddenException('this organization is not active');
    }
    return tenant;
  }

  private async ensureMembership(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    role: TenantRole,
    invited: boolean,
  ): Promise<void> {
    const existing = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { id: true, status: true, invited: true },
    });
    let membershipId: string;
    if (existing) {
      membershipId = existing.id;
      if (existing.status !== MembershipStatus.active || (invited && !existing.invited)) {
        await tx.membership.update({
          where: { id: membershipId },
          data: {
            ...(existing.status !== MembershipStatus.active
              ? { status: MembershipStatus.active }
              : {}),
            ...(invited ? { invited: true } : {}),
          },
        });
      }
    } else {
      const created = await tx.membership.create({
        data: { tenantId, userId, status: MembershipStatus.active, invited },
        select: { id: true },
      });
      membershipId = created.id;
    }

    const rolePresent = await tx.roleAssignment.findUnique({
      where: { membershipId_role: { membershipId, role } },
      select: { id: true },
    });
    if (!rolePresent) {
      await tx.roleAssignment.create({
        data: {
          tenantId,
          membershipId,
          role,
          source: LOCAL_SOURCE,
        },
      });
    }
  }
}
