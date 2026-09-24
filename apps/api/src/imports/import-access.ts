import { TenantRole } from '@aeg-clouddfir/database';
import type { AuthContext } from '../common/http.js';

export function mayReadImport(
  auth: AuthContext,
  createdById: string,
  assignedCaseMember: boolean,
): boolean {
  return (
    auth.userId === createdById || auth.roles.includes(TenantRole.org_admin) || assignedCaseMember
  );
}
