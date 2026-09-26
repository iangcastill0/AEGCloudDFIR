import { z } from 'zod';
import { tenantRole } from './common.js';

export const createTenantRequest = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(2).max(63),
});
export type CreateTenantRequest = z.infer<typeof createTenantRequest>;

export const createTenantResponse = z.object({
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type CreateTenantResponse = z.infer<typeof createTenantResponse>;

/**
 * Roles an email invite may grant.
 *
 * Public Authentik enrollment does not verify mailbox ownership (ADR-014: no
 * confirmation mail). Matching the invite email to the signed-in address is
 * therefore not proof the person controls that mailbox — anyone who sees the
 * invite URL can register as that address and redeem. Elevated roles
 * (org_admin / case_manager / production_manager) must be granted from
 * Members after an admin has looked at who actually joined.
 */
export const emailInviteRole = z.enum(['reviewer', 'read_only', 'auditor']);
export type EmailInviteRole = z.infer<typeof emailInviteRole>;

export const createInviteRequest = z.object({
  email: z.string().trim().email().max(320),
  role: emailInviteRole,
});
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;

export const grantMemberRoleRequest = z.object({
  role: tenantRole,
});
export type GrantMemberRoleRequest = z.infer<typeof grantMemberRoleRequest>;

export const grantMemberRoleResponse = z.object({
  membershipId: z.string().uuid(),
  role: tenantRole,
  granted: z.boolean(),
});
export type GrantMemberRoleResponse = z.infer<typeof grantMemberRoleResponse>;

export const createInviteResponse = z.object({
  inviteId: z.string().uuid(),
  email: z.string(),
  role: tenantRole,
  expiresAt: z.string(),
  inviteUrl: z.string().url(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponse>;

export const joinRequest = z.object({
  token: z.string().min(16).max(128),
});
export type JoinRequest = z.infer<typeof joinRequest>;

export const joinResponse = z.object({
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type JoinResponse = z.infer<typeof joinResponse>;

export const joinLinkResponse = z.object({
  inviteUrl: z.string().url(),
  role: tenantRole,
});
export type JoinLinkResponse = z.infer<typeof joinLinkResponse>;

export const authTenantsResponse = z.object({
  canCreateTenant: z.boolean(),
  tenants: z.array(
    z.object({
      tenantId: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
      status: z.string(),
      roles: z.array(z.string()),
    }),
  ),
});
export type AuthTenantsResponse = z.infer<typeof authTenantsResponse>;
