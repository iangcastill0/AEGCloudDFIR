# Authentik setup guide

AEG-CloudDFIR delegates all login to Authentik via standards-compliant OIDC
(authorization code + PKCE). No local passwords exist.

## Local development (compose)

The compose stack starts Authentik at `http://localhost:9443` with the
bootstrap admin `akadmin@localhost` / `CDFIR_LOCAL_AUTHENTIK_ADMIN_PASSWORD`
(default `admin-local-only`). Blueprints under `infra/authentik/blueprints/`
are auto-applied and create:

- Enrollment flow `cdfir-enrollment` (sign up) and authentication flow
  `cdfir-authentication` (sign in, with a Sign up link)
- OAuth2 provider `cdfir` (confidential, code flow, PKCE-capable)
- Application “AEG-CloudDFIR”
- Optional groups `cdfir-org-admins`, `cdfir-case-managers`, `cdfir-reviewers`

Then set in `.env`:

```
CDFIR_OIDC_ISSUER=http://localhost:9443/application/o/cdfir/
CDFIR_OIDC_CLIENT_ID=cdfir
CDFIR_OIDC_CLIENT_SECRET=changeme-local-only   # or the secret you set in the UI
```

## Production checklist

1. Create the provider from the blueprint (or manually) with redirect URI
   `https://api.<your-domain>/auth/callback` (strict matching).
2. Use a proper signing certificate; keep default `sub_mode` stable — user
   identity in AEG-CloudDFIR keys on `(issuer, sub)`, so **changing sub_mode
   or the issuer URL later orphans accounts**.
3. **MFA**: the blueprints bind TOTP to enrollment (`cdfir-totp-setup`) and to
   every later sign-in (`cdfir-authentication-mfa`, `not_configured_action:
configure`). There is no confirmation email. AEG-CloudDFIR deliberately
   contains no second factor of its own; IdP policy is authoritative.
4. Token lifetimes: short access-token validity is fine — AEG-CloudDFIR only
   uses the id_token at login and keeps its own sealed session cookie
   (`CDFIR_SESSION_TTL_SECONDS`, default 8 h).
5. Group→role mapping (optional): add the `groups` scope/claim to the
   provider, then set:
   ```
   CDFIR_OIDC_GROUP_CLAIM=groups
   CDFIR_OIDC_GROUP_ROLE_MAP=cdfir-org-admins:org_admin,cdfir-case-managers:case_manager,cdfir-reviewers:reviewer
   ```
   Mapped roles are re-synced at every login (source `oidc_group`) and
   coexist with locally assigned roles. Leave `CDFIR_OIDC_GROUP_CLAIM` empty to
   manage roles entirely inside AEG-CloudDFIR.
6. Logout: AEG-CloudDFIR calls the discovered `end_session_endpoint` for
   RP-initiated logout when advertised.
7. **Sign up (enrollment):** the provider uses authentication flow
   `cdfir-authentication`, whose identification stage links to
   `cdfir-enrollment`. Sign in and Sign up in the web app both go to
   `{API}/auth/login`. Do not build a password form in Next.js.
8. **SMTP (optional):** enrollment does not send mail. Set these only if you
   want Authentik password recovery. Put them on **both** `authentik-server`
   and `authentik-worker` in the host `.env`:
   ```
   AUTHENTIK_EMAIL__HOST=smtp.example.com
   AUTHENTIK_EMAIL__PORT=587
   AUTHENTIK_EMAIL__USERNAME=...
   AUTHENTIK_EMAIL__PASSWORD=...
   AUTHENTIK_EMAIL__USE_TLS=true
   AUTHENTIK_EMAIL__FROM=AEG-CloudDFIR <noreply@example.com>
   ```
   Do not list empty values in compose — an empty HOST makes Authentik think
   mail is configured.

## If the login page has no Sign up link

The live site is on Authentik’s **default** login flow
(`/if/flow/default-authentication-flow/`). That page is login-only until the
`cdfir-enrollment` flow exists and is linked. Check:

```
https://auth.aegclouddfir.com/if/flow/cdfir-enrollment/
```

A 404 means the blueprint was never applied. The YAML lives at
`infra/authentik/blueprints/aeg-auth-flows.yaml`. Restart Authentik’s worker
after that file is on the host so it loads (see the deploy / Linode steps).
Then Providers → `cdfir` → Authentication flow should be
**CloudDFIR authentication**.

## Verifying

- `curl $CDFIR_OIDC_ISSUER.well-known/openid-configuration` returns metadata whose
  `issuer` exactly equals `CDFIR_OIDC_ISSUER` (trailing slash matters).
- The app’s public door is `{WEB}/signup`. The Authentik login page also shows
  a Sign up link. Completing enrollment (name, email, password, then a TOTP
  app) returns to `{API}/auth/callback` as a normal OIDC login. An org invite
  is `{WEB}/signup?token=…` and lands on that same page.
- Log in via the web app; `GET /api/v1/me` shows your identity; an
  `auth.tenant_selected` audit event appears after choosing a tenant. If
  `CDFIR_SELF_SERVE_SIGNUP=true`, a person with no memberships can create an
  organization from `/auth/tenant`. Each org has a standing join link on
  Members. Opening it and signing up (or in) adds that person as a reviewer.
