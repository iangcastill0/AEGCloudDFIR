import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantRole } from '@evidencevault/database';
import type { FastifyRequest } from 'fastify';
import '../../common/http.js';
import { ROLES_KEY } from './require-roles.decorator.js';

/**
 * Enforces @RequireRoles(...) — the caller must hold at least one of the
 * listed roles in the active tenant. The list is exact: org_admin grants
 * nothing implicitly, and auditor remains read-only with respect to evidence.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<TenantRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = request.evAuth;
    if (!auth || !required.some((role) => auth.roles.includes(role))) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
