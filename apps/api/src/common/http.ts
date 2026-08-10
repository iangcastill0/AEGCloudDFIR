import '@fastify/cookie';
import type { TenantRole } from '@evidencevault/database';
import type { SessionPayload } from '../auth/session.js';

/** Tenant-scoped authorization context attached by TenantGuard. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  membershipId: string;
  roles: TenantRole[];
  isPlatformAdmin: boolean;
  /** Display name (or email fallback) for audit entries. */
  actorDisplay: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation id echoed back as the x-request-id response header. */
    evRequestId?: string;
    /** Opened session, attached by SessionGuard. */
    evSession?: SessionPayload;
    /** Tenant-scoped auth context, attached by TenantGuard. */
    evAuth?: AuthContext;
  }
}
