import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyRequest } from 'fastify';
import '../../common/http.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { deriveSealingKey, openSession, sessionCookieName } from '../session.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/** Opens the sealed session cookie and attaches request.cdfirSession; 401 otherwise. */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly key: Buffer;
  private readonly cookieName: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly reflector: Reflector,
  ) {
    this.key = deriveSealingKey(config.CDFIR_SESSION_SECRET);
    this.cookieName = sessionCookieName(config.NODE_ENV === 'production');
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const sealed = request.cookies?.[this.cookieName];
    const session = typeof sealed === 'string' ? openSession(this.key, sealed) : null;
    if (!session) {
      throw new UnauthorizedException('authentication required');
    }
    request.cdfirSession = session;
    return true;
  }
}
