import { Prisma, TenantRole } from '@aeg-clouddfir/database';
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

/**
 * Prisma fragment matching live Review/search import ACL: non-import evidence
 * stays tenant-wide; imported evidence is the uploader, an org admin, a member
 * of a case the import is attached to, or a member of a case the item is in.
 */
export function importReadableEvidenceWhere(auth: AuthContext): Prisma.EvidenceItemWhereInput {
  if (auth.roles.includes(TenantRole.org_admin)) return {};
  return {
    OR: [
      { importId: null },
      { forensicImport: { is: { createdById: auth.userId } } },
      {
        forensicImport: {
          is: {
            cases: {
              some: { case: { members: { some: { membershipId: auth.membershipId } } } },
            },
          },
        },
      },
      {
        caseItems: {
          some: { case: { members: { some: { membershipId: auth.membershipId } } } },
        },
      },
    ],
  };
}
