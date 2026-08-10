import { Inject, Injectable } from '@nestjs/common';
import {
  withTenantContext,
  type Prisma,
  type PrismaClient,
  type TenantRole,
  type User,
} from '@evidencevault/database';
import { PRISMA, LOGGER } from '../common/tokens.js';
import type { AppLogger } from '../common/logger.js';
import type { MappedClaims } from './oidc-helpers.js';

export type MembershipWithTenantAndRoles = Prisma.MembershipGetPayload<{
  include: { tenant: true; roles: true };
}>;

const OIDC_GROUP_SOURCE = 'oidc_group';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Upsert the user record by unique (issuer, subject); users have no RLS. */
  async upsertUserFromClaims(claims: MappedClaims): Promise<User> {
    const now = new Date();
    return this.prisma.user.upsert({
      where: { issuer_subject: { issuer: claims.issuer, subject: claims.subject } },
      update: {
        email: claims.email,
        ...(claims.displayName.length > 0 ? { displayName: claims.displayName } : {}),
        lastLoginAt: now,
      },
      create: {
        issuer: claims.issuer,
        subject: claims.subject,
        email: claims.email,
        displayName: claims.displayName,
        lastLoginAt: now,
      },
    });
  }

  /**
   * Cross-tenant self lookup for a just-authenticated user. RLS: the
   * self_memberships / self_role_assignments / tenant_member_select policies
   * key off app.user_id, which only the auth layer sets, transaction-locally.
   */
  async listMemberships(userId: string): Promise<MembershipWithTenantAndRoles[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx.membership.findMany({
        where: { userId },
        include: { tenant: true, roles: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /**
   * Reconcile source='oidc_group' role assignments with the roles mapped from
   * the user's IdP groups, per tenant membership, inside each tenant's RLS
   * context. Locally-assigned roles are never touched.
   */
  async syncOidcGroupRoles(userId: string, mappedRoles: readonly TenantRole[]): Promise<void> {
    const memberships = await this.listMemberships(userId);
    for (const membership of memberships) {
      await withTenantContext(this.prisma, membership.tenantId, async (tx) => {
        // notIn: [] matches every row, so an empty mapping clears all oidc_group roles.
        const removed = await tx.roleAssignment.deleteMany({
          where: {
            membershipId: membership.id,
            source: OIDC_GROUP_SOURCE,
            role: { notIn: [...mappedRoles] },
          },
        });
        let added = 0;
        for (const role of mappedRoles) {
          const existing = await tx.roleAssignment.findUnique({
            where: { membershipId_role: { membershipId: membership.id, role } },
            select: { id: true },
          });
          if (!existing) {
            await tx.roleAssignment.create({
              data: {
                tenantId: membership.tenantId,
                membershipId: membership.id,
                role,
                source: OIDC_GROUP_SOURCE,
              },
            });
            added += 1;
          }
        }
        if (removed.count > 0 || added > 0) {
          this.logger.info(
            { userId, tenantId: membership.tenantId, removed: removed.count, added },
            'oidc group roles synced',
          );
        }
      });
    }
  }
}
