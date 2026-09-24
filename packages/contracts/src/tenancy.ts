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

export const createInviteRequest = z.object({
  email: z.string().trim().email().max(320),
  role: tenantRole,
});
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;

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
