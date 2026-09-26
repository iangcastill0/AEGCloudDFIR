import { TenantRole } from '@aeg-clouddfir/database';
import type { AuthContext } from './http.js';

/**
 * Roles that may search and open evidence. Passed to `@RequireRoles`, which is
 * exact — org_admin implies nothing. Self-serve create and bootstrap grant
 * only org_admin, so omitting it here 403s Review for the people who own the
 * tenant. Native download already listed this role; search and detail did not.
 */
export const EVIDENCE_READ_ROLES: TenantRole[] = [
  TenantRole.case_manager,
  TenantRole.reviewer,
  TenantRole.read_only,
  TenantRole.org_admin,
];

/** Roles whose evidence/search visibility is tenant-wide (not case-scoped). */
const TENANT_WIDE_READ_ROLES: readonly TenantRole[] = [
  TenantRole.org_admin,
  TenantRole.case_manager,
  TenantRole.reviewer,
  TenantRole.production_manager,
];

/**
 * True when the caller may only read evidence/search results within cases
 * they are assigned to (read_only without any tenant-wide read role).
 */
export function isCaseRestricted(auth: AuthContext): boolean {
  return (
    auth.roles.includes(TenantRole.read_only) &&
    !auth.roles.some((role) => TENANT_WIDE_READ_ROLES.includes(role))
  );
}

/** May the caller see privileged material in search results? */
export function mayViewPrivileged(auth: AuthContext): boolean {
  return auth.roles.some(
    (role) =>
      role === TenantRole.case_manager ||
      role === TenantRole.org_admin ||
      role === TenantRole.production_manager,
  );
}
