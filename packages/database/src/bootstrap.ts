import { PrismaClient, TenantRole, MembershipStatus, TenantStatus } from '@prisma/client';
import { withTenantContext } from './client.js';
import { withPlatformContext } from './platform.js';
import { appendAuditEvent } from './audit.js';

/**
 * First-run bootstrap: create a tenant and grant a named person the roles that
 * let them administer it.
 *
 * Why this exists as a separate, deliberately awkward entry point rather than a
 * self-service "first user becomes admin" rule: an automatic promotion means
 * whoever reaches a freshly deployed instance first owns it. On a platform that
 * holds other people's evidence, that is an unacceptable race. Granting the
 * first administrator is an operator action, performed with database
 * credentials, and it is recorded in the tenant's audit chain.
 */

/** Roles granted when the caller does not name any explicitly. */
export const DEFAULT_BOOTSTRAP_ROLES: readonly TenantRole[] = [TenantRole.org_admin];

/** Marks role assignments made here, so IdP group sync never removes them. */
const LOCAL_SOURCE = 'local';

export interface BootstrapOrgAdminInput {
  /** URL-safe tenant identifier, unique across the deployment. */
  tenantSlug: string;
  /** Human-readable tenant name; only used when creating the tenant. */
  tenantName: string;
  /** Email as it appears in the IdP's `email` claim. Matched case-insensitively. */
  email: string;
  /** Defaults to DEFAULT_BOOTSTRAP_ROLES. */
  roles?: readonly TenantRole[];
  /**
   * Also set the platform-operator flag. Separate from tenant roles on purpose:
   * platform admins administer the deployment and cannot read tenant evidence.
   */
  platformAdmin?: boolean;
}

export type BootstrapOrgAdminResult =
  | {
      /**
       * The tenant exists but no user carries this email yet. The app's user
       * row is keyed on (issuer, subject) and Authentik's subject is a salted
       * hash of the user id, so it cannot be computed here — only a real login
       * can create the row. Have the person sign in once, then re-run.
       */
      status: 'awaiting_first_login';
      tenantId: string;
      tenantSlug: string;
      tenantCreated: boolean;
      email: string;
    }
  | {
      status: 'granted';
      tenantId: string;
      tenantSlug: string;
      tenantCreated: boolean;
      userId: string;
      email: string;
      membershipCreated: boolean;
      /** Roles this run added. Empty on a re-run — the whole call is idempotent. */
      rolesAdded: TenantRole[];
      /** Every role the membership now holds. */
      rolesEffective: TenantRole[];
      platformAdminChanged: boolean;
    };

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Idempotent. Safe to re-run: it adds what is missing and reports what it
 * changed, so the two-phase flow (run, sign in, run again) needs no cleanup.
 */
export async function bootstrapOrgAdmin(
  prisma: PrismaClient,
  input: BootstrapOrgAdminInput,
): Promise<BootstrapOrgAdminResult> {
  const slug = input.tenantSlug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new BootstrapError(
      `tenant slug must be 2-63 chars of [a-z0-9-] starting alphanumeric, got "${input.tenantSlug}"`,
    );
  }
  // Normalized because IdPs vary in the case they emit and a duplicate tenant
  // admin created by capitalization alone would be a silent privilege split.
  const email = input.email.trim().toLowerCase();
  if (email.length === 0 || !email.includes('@')) {
    throw new BootstrapError(`"${input.email}" is not an email address`);
  }
  const roles = [...new Set(input.roles ?? DEFAULT_BOOTSTRAP_ROLES)];
  if (roles.length === 0) {
    throw new BootstrapError('at least one role is required');
  }

  // --- tenant (platform context: the only context RLS lets INSERT tenants) ---
  const { tenantId, tenantCreated } = await withPlatformContext(prisma, async (tx) => {
    const existing = await tx.tenant.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status !== TenantStatus.active) {
        throw new BootstrapError(
          `tenant "${slug}" exists but is ${existing.status}; refusing to grant admin on it`,
        );
      }
      return { tenantId: existing.id, tenantCreated: false };
    }
    const created = await tx.tenant.create({
      data: { name: input.tenantName.trim() || slug, slug },
      select: { id: true },
    });
    return { tenantId: created.id, tenantCreated: true };
  });

  // --- user (the users table carries no RLS; see the RLS migration) ---
  // insensitive rather than lowercasing at write time: existing rows were
  // written from IdP claims verbatim, so a case-sensitive match would miss them.
  const candidates = await prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, isPlatformAdmin: true, displayName: true },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) {
    return {
      status: 'awaiting_first_login',
      tenantId,
      tenantSlug: slug,
      tenantCreated,
      email,
    };
  }
  if (candidates.length > 1) {
    // Two identities share this address (e.g. the issuer was reconfigured).
    // Guessing which one to make an administrator is not a decision to automate.
    throw new BootstrapError(
      `${candidates.length} users carry the email ${email} (ids: ${candidates
        .map((c) => c.id)
        .join(', ')}); resolve the duplicate before granting admin`,
    );
  }
  const user = candidates[0]!;

  // --- membership + roles (tenant context) ---
  const { membershipCreated, rolesAdded, rolesEffective } = await withTenantContext(
    prisma,
    tenantId,
    async (tx) => {
      const existingMembership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user.id } },
        select: { id: true, status: true },
      });
      let membershipId: string;
      let created = false;
      if (existingMembership) {
        membershipId = existingMembership.id;
        if (existingMembership.status !== MembershipStatus.active) {
          await tx.membership.update({
            where: { id: membershipId },
            data: { status: MembershipStatus.active },
          });
        }
      } else {
        const m = await tx.membership.create({
          data: { tenantId, userId: user.id, status: MembershipStatus.active },
          select: { id: true },
        });
        membershipId = m.id;
        created = true;
      }

      const added: TenantRole[] = [];
      for (const role of roles) {
        // Unique on (membershipId, role), so a pre-existing assignment from IdP
        // group sync is left alone rather than being rewritten to source=local.
        const present = await tx.roleAssignment.findUnique({
          where: { membershipId_role: { membershipId, role } },
          select: { id: true },
        });
        if (present) continue;
        await tx.roleAssignment.create({
          data: { tenantId, membershipId, role, source: LOCAL_SOURCE },
        });
        added.push(role);
      }

      const all = await tx.roleAssignment.findMany({
        where: { membershipId },
        select: { role: true },
      });

      // Audited inside the tenant's own hash chain: a grant of administrative
      // access is exactly the kind of event a later reviewer must be able to
      // find. The actor is the operator running this, not an app user, so
      // actorUserId is left empty and the summary records the mechanism.
      await appendAuditEvent(tx, {
        tenantId,
        actorDisplay: 'operator (bootstrap CLI)',
        effectiveRoles: [],
        action: 'tenant.bootstrap_admin',
        targetType: 'user',
        targetId: user.id,
        summary: {
          email,
          tenantSlug: slug,
          tenantCreated,
          membershipCreated: created,
          rolesRequested: roles,
          rolesAdded: added,
          platformAdminRequested: input.platformAdmin === true,
        },
      });

      return {
        membershipCreated: created,
        rolesAdded: added,
        rolesEffective: all.map((r) => r.role),
      };
    },
  );

  let platformAdminChanged = false;
  if (input.platformAdmin === true && !user.isPlatformAdmin) {
    await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
    platformAdminChanged = true;
  }

  return {
    status: 'granted',
    tenantId,
    tenantSlug: slug,
    tenantCreated,
    userId: user.id,
    email,
    membershipCreated,
    rolesAdded,
    rolesEffective,
    platformAdminChanged,
  };
}
