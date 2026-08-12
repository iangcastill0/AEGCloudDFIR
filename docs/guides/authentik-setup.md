# Authentik setup guide

AEG-CloudDFIR delegates all login to Authentik via standards-compliant OIDC
(authorization code + PKCE). No local passwords exist.

## Local development (compose)

The compose stack starts Authentik at `http://localhost:9443` with the
bootstrap admin `akadmin@localhost` / `CDFIR_LOCAL_AUTHENTIK_ADMIN_PASSWORD`
(default `admin-local-only`). The blueprint at
`infra/authentik/blueprints/cdfir.yaml` is auto-applied and creates:

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
3. **MFA**: enforce it in the Authentik authentication flow (e.g., TOTP/WebAuthn
   stage bound to the flow). AEG-CloudDFIR deliberately contains no second
   factor of its own; IdP policy is authoritative.
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

## Verifying

- `curl $CDFIR_OIDC_ISSUER.well-known/openid-configuration` returns metadata whose
  `issuer` exactly equals `CDFIR_OIDC_ISSUER` (trailing slash matters).
- Log in via the web app; `GET /api/v1/me` shows your identity; an
  `auth.tenant_selected` audit event appears after choosing a tenant.
