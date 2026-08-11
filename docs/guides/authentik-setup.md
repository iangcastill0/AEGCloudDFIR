# Authentik setup guide

EvidenceVault delegates all login to Authentik via standards-compliant OIDC
(authorization code + PKCE). No local passwords exist.

## Local development (compose)

The compose stack starts Authentik at `http://localhost:9443` with the
bootstrap admin `akadmin@localhost` / `EV_LOCAL_AUTHENTIK_ADMIN_PASSWORD`
(default `admin-local-only`). The blueprint at
`infra/authentik/blueprints/evidencevault.yaml` is auto-applied and creates:

- OAuth2 provider `evidencevault` (confidential, code flow, PKCE-capable)
- Application “EvidenceVault”
- Optional groups `ev-org-admins`, `ev-case-managers`, `ev-reviewers`

Then set in `.env`:

```
EV_OIDC_ISSUER=http://localhost:9443/application/o/evidencevault/
EV_OIDC_CLIENT_ID=evidencevault
EV_OIDC_CLIENT_SECRET=changeme-local-only   # or the secret you set in the UI
```

## Production checklist

1. Create the provider from the blueprint (or manually) with redirect URI
   `https://api.<your-domain>/auth/callback` (strict matching).
2. Use a proper signing certificate; keep default `sub_mode` stable — user
   identity in EvidenceVault keys on `(issuer, sub)`, so **changing sub_mode
   or the issuer URL later orphans accounts**.
3. **MFA**: enforce it in the Authentik authentication flow (e.g., TOTP/WebAuthn
   stage bound to the flow). EvidenceVault deliberately contains no second
   factor of its own; IdP policy is authoritative.
4. Token lifetimes: short access-token validity is fine — EvidenceVault only
   uses the id_token at login and keeps its own sealed session cookie
   (`EV_SESSION_TTL_SECONDS`, default 8 h).
5. Group→role mapping (optional): add the `groups` scope/claim to the
   provider, then set:
   ```
   EV_OIDC_GROUP_CLAIM=groups
   EV_OIDC_GROUP_ROLE_MAP=ev-org-admins:org_admin,ev-case-managers:case_manager,ev-reviewers:reviewer
   ```
   Mapped roles are re-synced at every login (source `oidc_group`) and
   coexist with locally assigned roles. Leave `EV_OIDC_GROUP_CLAIM` empty to
   manage roles entirely inside EvidenceVault.
6. Logout: EvidenceVault calls the discovered `end_session_endpoint` for
   RP-initiated logout when advertised.

## Verifying

- `curl $EV_OIDC_ISSUER.well-known/openid-configuration` returns metadata whose
  `issuer` exactly equals `EV_OIDC_ISSUER` (trailing slash matters).
- Log in via the web app; `GET /api/v1/me` shows your identity; an
  `auth.tenant_selected` audit event appears after choosing a tenant.
