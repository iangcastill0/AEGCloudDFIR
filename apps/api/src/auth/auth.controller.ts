import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AppConfig } from '@evidencevault/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { z } from 'zod';
import '../common/http.js';
import { APP_CONFIG, LOGGER } from '../common/tokens.js';
import type { AppLogger } from '../common/logger.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from './auth.service.js';
import { OidcService } from './oidc.service.js';
import {
  buildAuthorizationParameters,
  extractGroups,
  mapIdTokenClaims,
  parseGroupRoleMap,
  rolesForGroups,
  validateRedirectTo,
} from './oidc-helpers.js';
import {
  AUTH_FLOW_COOKIE,
  CSRF_COOKIE,
  createSessionPayload,
  deriveSealingKey,
  openAuthFlow,
  sealAuthFlow,
  sealSession,
  sessionCookieName,
  type SessionPayload,
} from './session.js';
import { generateCsrfToken } from '../security/csrf.js';
import { Public } from './guards/public.decorator.js';
import { SessionGuard } from './guards/session.guard.js';

const AUTH_FLOW_TTL_SECONDS = 600;

const selectTenantSchema = z.object({ tenantId: z.string().uuid() });

@Controller('auth')
@UseGuards(SessionGuard)
export class AuthController {
  private readonly key: Buffer;
  private readonly isProd: boolean;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
    private readonly oidc: OidcService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {
    this.key = deriveSealingKey(config.EV_SESSION_SECRET);
    this.isProd = config.NODE_ENV === 'production';
  }

  private baseCookieOptions(): CookieSerializeOptions {
    return { path: '/', httpOnly: true, sameSite: 'lax', secure: this.isProd };
  }

  private setSessionCookie(reply: FastifyReply, payload: SessionPayload): void {
    const maxAge = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
    reply.setCookie(sessionCookieName(this.isProd), sealSession(this.key, payload), {
      ...this.baseCookieOptions(),
      maxAge,
    });
  }

  /** Issue a double-submit CSRF token (readable by JS by design). */
  @Public()
  @Get('csrf')
  csrf(@Res({ passthrough: true }) reply: FastifyReply): { token: string } {
    const token = generateCsrfToken();
    reply.setCookie(CSRF_COOKIE, token, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure: this.isProd,
    });
    return { token };
  }

  @Public()
  @Get('login')
  async login(
    @Query('redirectTo') redirectTo: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const verifier = this.oidc.generatePkceVerifier();
    const codeChallenge = await this.oidc.calculatePkceChallenge(verifier);
    const state = this.oidc.generateState();
    const nonce = this.oidc.generateNonce();

    const authorizationUrl = await this.oidc.buildAuthorizationUrl(
      buildAuthorizationParameters({
        apiPublicUrl: this.config.EV_API_PUBLIC_URL,
        state,
        nonce,
        codeChallenge,
      }),
    );

    const iat = Math.floor(Date.now() / 1000);
    const flowCookie = sealAuthFlow(this.key, {
      v: 1,
      kind: 'authflow',
      state,
      nonce,
      verifier,
      redirectTo: validateRedirectTo(redirectTo),
      iat,
      exp: iat + AUTH_FLOW_TTL_SECONDS,
    });
    reply.setCookie(AUTH_FLOW_COOKIE, flowCookie, {
      ...this.baseCookieOptions(),
      maxAge: AUTH_FLOW_TTL_SECONDS,
    });
    reply.redirect(302, authorizationUrl.toString());
  }

  @Public()
  @Get('callback')
  async callback(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const sealedFlow = request.cookies?.[AUTH_FLOW_COOKIE];
    const flow = typeof sealedFlow === 'string' ? openAuthFlow(this.key, sealedFlow) : null;
    if (!flow) {
      throw new BadRequestException('login flow missing or expired; restart login');
    }

    const currentUrl = new URL(request.url, this.config.EV_API_PUBLIC_URL);
    let tokens;
    try {
      tokens = await this.oidc.authorizationCodeGrant(currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
    } catch (err) {
      // Never log token material; the error message is protocol-level only.
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'oidc code exchange failed',
      );
      throw new UnauthorizedException('login failed');
    }

    const claims = mapIdTokenClaims(tokens.claims());
    if (!claims) {
      throw new UnauthorizedException('login failed: unusable ID token claims');
    }

    const user = await this.authService.upsertUserFromClaims(claims);

    if (this.config.EV_OIDC_GROUP_CLAIM.length > 0) {
      const map = parseGroupRoleMap(this.config.EV_OIDC_GROUP_ROLE_MAP, (message) =>
        this.logger.warn(message),
      );
      const rawClaims = tokens.claims();
      const groups = rawClaims
        ? extractGroups(rawClaims as Record<string, unknown>, this.config.EV_OIDC_GROUP_CLAIM)
        : [];
      await this.authService.syncOidcGroupRoles(user.id, rolesForGroups(groups, map));
    }

    this.logger.info({ userId: user.id, requestId: request.evRequestId }, 'auth.login');

    this.setSessionCookie(
      reply,
      createSessionPayload(user.id, undefined, this.config.EV_SESSION_TTL_SECONDS),
    );
    reply.clearCookie(AUTH_FLOW_COOKIE, { path: '/' });
    reply.redirect(302, `${this.config.EV_WEB_PUBLIC_URL}${validateRedirectTo(flow.redirectTo)}`);
  }

  /** CSRF-protected by the global CsrfGuard (mutating method). */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logoutUrl: string | null }> {
    const session = request.evSession;
    if (session?.tenantId) {
      await this.audit.append({
        tenantId: session.tenantId,
        actorUserId: session.userId,
        action: 'auth.logout',
        request,
      });
    }
    reply.clearCookie(sessionCookieName(this.isProd), this.baseCookieOptions());
    const logoutUrl = await this.oidc.endSessionUrl(this.config.EV_WEB_PUBLIC_URL);
    return { logoutUrl };
  }

  @Get('tenants')
  async tenants(@Req() request: FastifyRequest): Promise<{
    tenants: Array<{
      tenantId: string;
      name: string;
      slug: string;
      status: string;
      roles: string[];
    }>;
  }> {
    const session = request.evSession;
    if (!session) throw new UnauthorizedException();
    const memberships = await this.authService.listMemberships(session.userId);
    return {
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId,
        name: m.tenant.name,
        slug: m.tenant.slug,
        status: m.status,
        roles: m.roles.map((r) => r.role),
      })),
    };
  }

  /** CSRF-protected by the global CsrfGuard (mutating method). */
  @Post('select-tenant')
  @HttpCode(200)
  async selectTenant(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const session = request.evSession;
    if (!session) throw new UnauthorizedException();
    const parsed = selectTenantSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('tenantId (uuid) is required');
    const { tenantId } = parsed.data;

    const memberships = await this.authService.listMemberships(session.userId);
    const membership = memberships.find((m) => m.tenantId === tenantId);
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException('no active membership in this tenant');
    }

    // Reseal with the tenant selection, preserving the original expiry.
    this.setSessionCookie(reply, { ...session, tenantId });

    await this.audit.append({
      tenantId,
      actorUserId: session.userId,
      effectiveRoles: membership.roles.map((r) => r.role),
      action: 'auth.tenant_selected',
      targetType: 'tenant',
      targetId: tenantId,
      request,
    });

    return { ok: true };
  }
}
