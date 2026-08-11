# Microsoft Entra setup guide

Two independent modes. Both are **read-only**: EvidenceVault never requests
write or send permissions.

## A. Delegated mode (personal + work/school accounts)

Registers EvidenceVault's own multi-tenant app; each user consents for their
own mailbox/OneDrive. **Delegated access collects only what that signed-in
identity can see — it does not make other tenant users selectable**, and the
UI states this on the custodian step.

1. Entra admin center → App registrations → New registration
   - Supported account types: _Accounts in any organizational directory and
     personal Microsoft accounts_ (or narrower if you don't need personal).
   - Redirect URI (Web): `https://api.<your-domain>/auth/../api/v1/connectors/callback/microsoft`
     — exactly the value of `EV_API_PUBLIC_URL + EV_MS_REDIRECT_PATH`
     (default path `/api/v1/connectors/callback/microsoft`).
2. Certificates & secrets → New client secret. Record it once.
3. API permissions → Microsoft Graph → **Delegated**:
   - `openid`, `profile`, `email`, `offline_access`
   - `User.Read`
   - `Mail.Read` (email collection)
   - `Files.Read` (OneDrive; `Files.Read.All` only if shared content is needed)
     No admin consent is required for these delegated read scopes in most
     tenants; individual tenants may require admin approval by policy.
4. Configure EvidenceVault:
   ```
   EV_MS_CLIENT_ID=<application (client) id>
   EV_MS_CLIENT_SECRET=<secret>
   ```

Token behavior: Microsoft rotates refresh tokens; EvidenceVault persists the
rotated token (re-encrypted) on every refresh. Revoking the app from
`https://myaccount.microsoft.com` → _App permissions_ invalidates collection
until reconnected.

## B. Organization mode (application permissions + admin consent)

For org-wide collection, a **tenant admin** of the _target_ organization
consents to application permissions. EvidenceVault then enumerates users and
collects selected custodians without per-user sign-in.

1. Use the same app registration (or a dedicated single-tenant one supplied by
   the customer org).
2. API permissions → Microsoft Graph → **Application**:
   - `User.Read.All` (custodian enumeration)
   - `Mail.Read` (all-mailbox read)
   - `Files.Read.All` (OneDrive read)
3. In EvidenceVault: Connectors → Microsoft → _Organization mode_ → enter the
   Entra tenant ID → open the generated admin-consent URL
   (`https://login.microsoftonline.com/{tenant}/adminconsent?...`) as a Global
   Administrator and approve.

### Constraining scope (strongly recommended — do this before consent)

Application `Mail.Read` is tenant-wide by default. Microsoft-supported
controls to narrow it:

- **RBAC for Applications (Exchange Online)**: assign the app a management
  scope so it can read only specific mailboxes/OUs:
  `New-ManagementScope -Name "EV-Custodians" -RecipientRestrictionFilter {...}`
  then `New-ServicePrincipal` + `New-ManagementRoleAssignment -App ... -Role
"Application Mail.Read" -CustomResourceScope "EV-Custodians"`.
- **Application access policies** (older mechanism):
  `New-ApplicationAccessPolicy -AppId <id> -PolicyScopeGroupId
ev-collection-scope@contoso.com -AccessRight RestrictAccess`.
- SharePoint/OneDrive: `Sites.Selected`-style narrowing does not apply to
  `Files.Read.All`; where site-level scoping is required, grant
  `Sites.Selected` instead and accept that only granted sites are readable.

EvidenceVault honors the resulting 403s as **permission_denied exceptions** in
the collection's exception ledger — it never tries to bypass tenant-side
scoping, and the completeness state reflects them.

## Verification

- Connectors → _Test_ runs a folder listing under the configured identity.
- A one-item collection produces a manifest whose `permissionMode` is
  `delegated` or `organization` and lists the exact Graph endpoint families
  used.
