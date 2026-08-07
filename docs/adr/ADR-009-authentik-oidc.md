# ADR-009: Authentik as sole IdP via standards-only OIDC

Status: accepted · Date: 2026-08-07

## Context

Login must use Authentik through standards-compliant OpenID Connect; MFA is
an IdP policy concern.

## Decision

The api implements a BFF: /auth/login starts code+PKCE with nonce/state;
/auth/callback validates iss, aud, sig (JWKS), exp, nonce, state; a sealed
HttpOnly __Host- session cookie carries only the local user id + expiry.
Nothing Authentik-proprietary is used, so any conformant IdP works; the
shipped blueprint targets Authentik. Optional group claim maps to roles on
each login. Connector OAuth tokens are stored in ConnectorSecret, entirely
separate from login sessions.

## Consequences

No local passwords; logout uses RP-initiated end_session when advertised.
