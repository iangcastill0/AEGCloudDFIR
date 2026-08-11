import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '@evidencevault/config';
import * as client from 'openid-client';
import { APP_CONFIG, LOGGER } from '../common/tokens.js';
import type { AppLogger } from '../common/logger.js';

export type TokenResponse = Awaited<ReturnType<typeof client.authorizationCodeGrant>>;

export interface CodeGrantChecks {
  pkceCodeVerifier: string;
  expectedState: string;
  expectedNonce: string;
}

/**
 * Thin adapter around the openid-client v6 functional API. Discovery is lazy
 * and cached; failures surface as 503 (identity provider unavailable) rather
 * than crashing the process. All protocol validation (issuer, signature,
 * audience, expiry, state, nonce, PKCE) is delegated to openid-client.
 */
@Injectable()
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  private async getConfiguration(): Promise<client.Configuration> {
    try {
      const issuerUrl = new URL(this.appConfig.EV_OIDC_ISSUER);
      // openid-client v6 refuses plain-HTTP issuers unless explicitly allowed.
      // Permit it only outside production (local Authentik in the compose stack).
      const allowHttp = issuerUrl.protocol === 'http:' && this.appConfig.NODE_ENV !== 'production';
      this.configPromise ??= client.discovery(
        issuerUrl,
        this.appConfig.EV_OIDC_CLIENT_ID,
        this.appConfig.EV_OIDC_CLIENT_SECRET,
        undefined,
        allowHttp ? { execute: [client.allowInsecureRequests] } : undefined,
      );
      return await this.configPromise;
    } catch (err) {
      this.configPromise = null;
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'oidc discovery failed',
      );
      throw new ServiceUnavailableException('identity provider unavailable');
    }
  }

  generatePkceVerifier(): string {
    return client.randomPKCECodeVerifier();
  }

  async calculatePkceChallenge(verifier: string): Promise<string> {
    return client.calculatePKCECodeChallenge(verifier);
  }

  generateState(): string {
    return client.randomState();
  }

  generateNonce(): string {
    return client.randomNonce();
  }

  async buildAuthorizationUrl(parameters: Record<string, string>): Promise<URL> {
    const config = await this.getConfiguration();
    return client.buildAuthorizationUrl(config, parameters);
  }

  /** Redeems the code; openid-client validates state, nonce, issuer, signature, expiry. */
  async authorizationCodeGrant(currentUrl: URL, checks: CodeGrantChecks): Promise<TokenResponse> {
    const config = await this.getConfiguration();
    return client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.pkceCodeVerifier,
      expectedState: checks.expectedState,
      expectedNonce: checks.expectedNonce,
      idTokenExpected: true,
    });
  }

  /**
   * RP-initiated logout URL when the IdP advertises end_session_endpoint.
   * We never persist id tokens, so id_token_hint is intentionally omitted.
   * Returns null when discovery fails or the endpoint is not advertised.
   */
  async endSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
    let config: client.Configuration;
    try {
      config = await this.getConfiguration();
    } catch {
      return null;
    }
    if (!config.serverMetadata().end_session_endpoint) return null;
    return client
      .buildEndSessionUrl(config, {
        post_logout_redirect_uri: postLogoutRedirectUri,
        client_id: this.appConfig.EV_OIDC_CLIENT_ID,
      })
      .toString();
  }
}
