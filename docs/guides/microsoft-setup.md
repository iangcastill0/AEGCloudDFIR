# Microsoft Entra setup guide

Two independent modes. Both are **read-only**: AEG-CloudDFIR never requests
write or send permissions.

## A. Delegated mode (personal + work/school accounts)

Registers AEG-CloudDFIR's own multi-tenant app; each user consents for their
own mailbox/OneDrive. **Delegated access collects only what that signed-in
identity can see — it does not make other tenant users selectable**, and the
UI states this on the custodian step.

1. Entra admin center → App registrations → New registration
   - Supported account types: _Accounts in any organizational directory and
     personal Microsoft accounts_ (or narrower if you don't need personal).
   - Redirect URI (Web): `https://api.<your-domain>/auth/../api/v1/connectors/callback/microsoft`
     — exactly the value of `CDFIR_API_PUBLIC_URL + CDFIR_MS_REDIRECT_PATH`
     (default path `/api/v1/connectors/callback/microsoft`).
2. Certificates & secrets → New client secret. Record it once.
3. API permissions → Microsoft Graph → **Delegated**:
   - `openid`, `profile`, `email`, `offline_access`
   - `User.Read`
   - `Mail.Read` (email collection)
   - `Files.Read` (OneDrive; `Files.Read.All` only if shared content is needed)
     No admin consent is required for these delegated read scopes in most
     tenants; individual tenants may require admin approval by policy.
4. Configure AEG-CloudDFIR:
   ```
   CDFIR_MS_CLIENT_ID=<application (client) id>
   CDFIR_MS_CLIENT_SECRET=<secret>
   ```

Token behavior: Microsoft rotates refresh tokens; AEG-CloudDFIR persists the
rotated token (re-encrypted) on every refresh. Revoking the app from
`https://myaccount.microsoft.com` → _App permissions_ invalidates collection
until reconnected.

## B. Organization mode (application permissions + admin consent)

For org-wide collection, a **tenant admin** of the _target_ organization
consents to application permissions. AEG-CloudDFIR then enumerates users and
collects selected custodians without per-user sign-in.

1. Use the same app registration (or a dedicated single-tenant one supplied by
   the customer org).
2. API permissions → Microsoft Graph → **Application**:
   - `User.Read.All` (custodian enumeration)
   - `Mail.Read` (all-mailbox read)
   - `Files.Read.All` (OneDrive read)
3. In AEG-CloudDFIR: Connectors → Microsoft → _Organization mode_ → enter the
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
cdfir-collection-scope@contoso.com -AccessRight RestrictAccess`.
- SharePoint/OneDrive: `Sites.Selected`-style narrowing does not apply to
  `Files.Read.All`; where site-level scoping is required, grant
  `Sites.Selected` instead and accept that only granted sites are readable.

AEG-CloudDFIR honors the resulting 403s as **permission_denied exceptions** in
the collection's exception ledger — it never tries to bypass tenant-side
scoping, and the completeness state reflects them.

## Audit log collection

Audit logs are collected **organization-wide only** — they use application
permissions and tenant admin consent, never per-custodian delegated access. A
delegated-only connector cannot collect audit logs; the connector must be in
**Organization mode** (section B above).

AEG-CloudDFIR collects Microsoft audit events from two upstream systems:

- **`o365_management_activity`** — the Office 365 Management Activity API, for
  unified audit content types: `Audit.Exchange`, `Audit.SharePoint`,
  `Audit.AzureActiveDirectory`, `Audit.General`, and `DLP.All`.
- **`graph_directory_audits`** and **`graph_signins`** — Microsoft Graph
  directory audit logs and sign-in logs.

### 1. Enable the Unified Audit Log

Auditing must be turned on **in the tenant** for events to exist at all.
Enable the Purview / Unified Audit Log (Microsoft Purview compliance portal →
Audit → _Turn on auditing_, or `Enable-OrganizationCustomization` +
`Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true`). Events that
occurred while auditing was disabled were never recorded and cannot be
collected.

### 2. Grant application permissions

Add these **Application** permissions to the app registration used for
Organization mode, then obtain tenant admin consent:

- **Office 365 Management APIs** → `ActivityFeed.Read` — unified audit content
  (`o365_management_activity`).
- **Microsoft Graph** → `AuditLog.Read.All` — directory audits
  (`graph_directory_audits`) and sign-in logs (`graph_signins`).

Consent as a Global Administrator via the generated admin-consent URL, the same
way as the other Organization-mode permissions.

### 3. Retention caveat (honest limitation)

Standard Purview Audit retains audit events for approximately **180 days**.
Events older than the retained window — or never captured because auditing was
disabled when they occurred — cannot be collected and are reported as **scope
limitations** in the collection's completeness state, not silently omitted.

## Verification

- Connectors → _Test_ runs a folder listing under the configured identity.
- A one-item collection produces a manifest whose `permissionMode` is
  `delegated` or `organization` and lists the exact Graph endpoint families
  used.
