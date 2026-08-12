import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { TenantRole } from '@aeg-clouddfir/database';

export const ROLES_KEY = 'ev:requiredRoles';

/**
 * Require at least one of the listed tenant roles. The list is exact —
 * org_admin does not implicitly satisfy other role requirements.
 */
export const RequireRoles = (...roles: TenantRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);
