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
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { z } from 'zod';
import '../common/http.js';
import { APP_CONFIG, LOGGER } from '../common/tokens.js';
import type { AppLogger } from '../common/logger.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from './auth.service.js';
import { OidcService } from './oidc.service.js';
import { TenantsService } from '../tenants/tenants.service.js';
import { joinRequest } from '@aeg-clouddfir/contracts';
import { zodValidate } from '../common/zod-validate.js';
import {
  MAX_LOGIN_RESTARTS,
  attemptFromState,
  buildAuthorizationParameters,
  clampAttempt,
  extractGroups,
  loginRestartUrl,
  mapIdTokenClaims,
  oauthErrorFields,
  parseGroupRoleMap,
  rolesForGroups,
  stateWithAttempt,
  validateRedirectTo,
} from './oidc-helpers.js';
import {
  AUTH_FLOW_COOKIE,
  CSRF_COOKIE,
  createSessionPayload,
  deriveSealingKey,
  openAuthFlow,
  sealAuthFlow,
  sessionCookieName,
  writeSessionCookie,
  type SessionPayload,
} from './session.js';
import { generateCsrfToken } from '../security/csrf.js';
import { Public } from './guards/public.decorator.js';
import { SessionGuard } from './guards/session.guard.js';

const AUTH_FLOW_TTL_SECONDS = 600;

/**
 * Auth responses must never be stored. The login redirect carries the state,
 * the nonce, the PKCE challenge and a Set-Cookie; the callback URL carries an
 * authorization code. Nothing was setting this — helmet does not — so the only
 * thing keeping them out of a cache was that a 302 is not heuristically
 * cacheable. That is a rule about browsers, not about every proxy in between.
 */
function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

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
    private readonly tenantsService: TenantsService,
    private readonly audit: AuditService,
  ) {
    this.key = deriveSealingKey(config.CDFIR_SESSION_SECRET);
    this.isProd = config.NODE_ENV === 'production';
  }

  private baseCookieOptions(): CookieSerializeOptions {
    return { path: '/', httpOnly: true, sameSite: 'lax', secure: this.isProd };
  }

  private setSessionCookie(reply: FastifyReply, payload: SessionPayload): void {
    writeSessionCookie(reply, this.key, payload, this.isProd);
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
    @Query('attempt') attempt: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    noStore(reply);
    const verifier = this.oidc.generatePkceVerifier();
    const codeChallenge = await this.oidc.calculatePkceChallenge(verifier);
    // The attempt rides in the state so a restarted login cannot restart again
    // forever; see MAX_LOGIN_RESTARTS.
    const state = stateWithAttempt(this.oidc.generateState(), clampAttempt(attempt));
    const nonce = this.oidc.generateNonce();

    const authorizationUrl = await this.oidc.buildAuthorizationUrl(
      buildAuthorizationParameters({
        apiPublicUrl: this.config.CDFIR_API_PUBLIC_URL,
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
    noStore(reply);
    const sealedFlow = request.cookies?.[AUTH_FLOW_COOKIE];
    const flow = typeof sealedFlow === 'string' ? openAuthFlow(this.key, sealedFlow) : null;
    if (!flow) {
      // Start a fresh login instead of dead-ending.
      //
      // This used to answer 400 and stop. Reloading the page could never help:
      // the authorization code is single-use and the flow cookie lives ten
      // minutes, so a callback URL that is reopened later — a refreshed error
      // page, a tab restored from yesterday, an address-bar autocomplete — is
      // permanently unusable. Staging logged eight of these in one session
      // against a single real sign-in, and the operator had no way forward
      // except to know the login URL by heart.
      const attempt = attemptFromState(
        (request.query as Record<string, unknown> | undefined)?.state,
      );
      if (attempt < MAX_LOGIN_RESTARTS) {
        reply.redirect(302, loginRestartUrl(this.config.CDFIR_API_PUBLIC_URL, attempt + 1));
        return;
      }
      throw new BadRequestException(
        'could not start a login session. Check that cookies are enabled for this site, then try again.',
      );
    }

    const currentUrl = new URL(request.url, this.config.CDFIR_API_PUBLIC_URL);
    let tokens;
    try {
      tokens = await this.oidc.authorizationCodeGrant(currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
    } catch (err) {
      // Log the OAuth error code and description alongside the message. They are
      // protocol-level, never token material, and they are the difference
      // between a diagnosable failure and a guess: openid-client's message is
      // the same string ("server responded with an error in the response body")
      // whether the client secret is wrong, the code expired, PKCE failed, or
      // the redirect URI did not match. Without this, the only way to tell was
      // to read the identity provider's own logs.
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), ...oauthErrorFields(err) },
        'oidc code exchange failed',
      );
      throw new UnauthorizedException('login failed');
    }

    const claims = mapIdTokenClaims(tokens.claims());
    if (!claims) {
      throw new UnauthorizedException('login failed: unusable ID token claims');
    }

    const user = await this.authService.upsertUserFromClaims(claims);

    if (this.config.CDFIR_OIDC_GROUP_CLAIM.length > 0) {
      const map = parseGroupRoleMap(this.config.CDFIR_OIDC_GROUP_ROLE_MAP, (message) =>
        this.logger.warn(message),
      );
      const rawClaims = tokens.claims();
      const groups = rawClaims
        ? extractGroups(rawClaims as Record<string, unknown>, this.config.CDFIR_OIDC_GROUP_CLAIM)
        : [];
      await this.authService.syncOidcGroupRoles(user.id, rolesForGroups(groups, map));
    }

    this.logger.info({ userId: user.id, requestId: request.cdfirRequestId }, 'auth.login');

    this.setSessionCookie(
      reply,
      createSessionPayload(user.id, undefined, this.config.CDFIR_SESSION_TTL_SECONDS),
    );
    reply.clearCookie(AUTH_FLOW_COOKIE, { path: '/' });
    reply.redirect(
      302,
      `${this.config.CDFIR_WEB_PUBLIC_URL}${validateRedirectTo(flow.redirectTo)}`,
    );
  }

  /** CSRF-protected by the global CsrfGuard (mutating method). */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logoutUrl: string | null }> {
    const session = request.cdfirSession;
    if (session?.tenantId) {
      await this.audit.append({
        tenantId: session.tenantId,
        actorUserId: session.userId,
        action: 'auth.logout',
        request,
      });
    }
    reply.clearCookie(sessionCookieName(this.isProd), this.baseCookieOptions());
    const logoutUrl = await this.oidc.endSessionUrl(this.config.CDFIR_WEB_PUBLIC_URL);
    return { logoutUrl };
  }

  @Get('tenants')
  async tenants(@Req() request: FastifyRequest): Promise<{
    canCreateTenant: boolean;
    tenants: Array<{
      tenantId: string;
      name: string;
      slug: string;
      status: string;
      roles: string[];
    }>;
  }> {
    const session = request.cdfirSession;
    if (!session) throw new UnauthorizedException();
    const memberships = await this.authService.listMemberships(session.userId);
    return {
      canCreateTenant: this.tenantsService.canCreateTenant(),
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
    const session = request.cdfirSession;
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

  /** CSRF-protected by the global CsrfGuard (mutating method). */
  @Post('join')
  @HttpCode(200)
  async join(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ tenantId: string; name: string; slug: string }> {
    const session = request.cdfirSession;
    if (!session) throw new UnauthorizedException();
    const parsed = zodValidate(joinRequest, body);
    const joined = await this.tenantsService.redeemInvite(session.userId, parsed.token, request);
    this.setSessionCookie(reply, { ...session, tenantId: joined.tenantId });
    return joined;
  }
}
