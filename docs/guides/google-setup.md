# Google setup guide

Two independent modes, both read-only.

## A. Delegated OAuth (personal Google + Google Workspace users)

1. Google Cloud Console → create/select a project → _APIs & Services_.
2. Enable APIs: **Gmail API**, **Google Drive API** (org mode later also needs
   **Admin SDK API**).
3. OAuth consent screen: External (for personal accounts) or Internal
   (Workspace-only). Add scopes below; apps requesting Gmail/Drive restricted
   scopes for external users require Google's verification process for
   production use (test mode works for evaluation with listed test users).
4. Credentials → OAuth client ID → Web application:
   - Authorized redirect URI: `EV_API_PUBLIC_URL + EV_GOOGLE_REDIRECT_PATH`
     (default `https://api.<your-domain>/api/v1/connectors/callback/google`).
5. Configure EvidenceVault:
   ```
   EV_GOOGLE_CLIENT_ID=<client id>
   EV_GOOGLE_CLIENT_SECRET=<client secret>
   ```

Exact scopes requested (least privilege, read-only):

```
openid email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
```

Personal OAuth collects only the consenting user's own data. Users revoke at
`https://myaccount.google.com/permissions`.

## B. Workspace organization mode (service account + domain-wide delegation)

A Workspace **super administrator** performs steps 2–3.

1. In the Cloud project: IAM & Admin → Service accounts → create
   `evidencevault-collector`. Create a JSON key. **Handle it like a domain
   master key.** You will paste it into EvidenceVault once; it is envelope-
   encrypted immediately and never displayed again.
2. Google Admin console → Security → Access and data control → API controls →
   **Domain-wide delegation** → Add new:
   - Client ID: the service account's numeric client ID
   - OAuth scopes (exactly these):
     ```
     https://www.googleapis.com/auth/gmail.readonly,
     https://www.googleapis.com/auth/drive.readonly,
     https://www.googleapis.com/auth/admin.directory.user.readonly
     ```
3. Decide which domain(s) may be impersonated.
4. In EvidenceVault: Connectors → Google → _Organization mode_ → paste the
   JSON key, the allowed domain list, and an admin email (used only for
   directory enumeration). EvidenceVault refuses to impersonate any address
   outside the allowed domains (`DomainNotAllowedError`), and only custodians
   you explicitly select are ever impersonated.

### Notes and honest limitations

- Google-native files (Docs/Sheets/Slides/Drawings) cannot be downloaded
  byte-for-byte; they are preserved as **API exports** (PDF + editable Office
  format where supported), flagged `apiExportDerivative` in evidence records,
  manifests, exports, and the UI.
- `files.export` caps exports around 10 MB per format; larger Google-native
  files are recorded as exceptions.
- Gmail history checkpoints can expire; EvidenceVault then runs a
  reconciliation scan and records an `expired_checkpoint` exception — visible
  in the collection report.

## Audit log collection

Audit logs are collected **organization-wide only** — they rely on domain-wide
delegation, never per-custodian delegated OAuth. A delegated-only connector
cannot collect audit logs; the connector must be in **Organization mode**
(section B above).

EvidenceVault collects Google audit events from two upstream systems:

- **`google_reports`** — the Admin SDK Reports API, covering the activity
  applications: login, drive, admin, token, mobile, user_accounts, groups, and
  SAML applications.
- **`google_vault`** — Google Vault (metadata-only; see caveat below).

### 1. Add the audit DWD scopes

Extend the existing domain-wide delegation grant (Admin console → Security →
Access and data control → API controls → **Domain-wide delegation** → edit the
`evidencevault-collector` client) with these two scopes alongside the
collection scopes already listed in section B:

```
https://www.googleapis.com/auth/admin.reports.audit.readonly,
https://www.googleapis.com/auth/ediscovery.readonly
```

- `admin.reports.audit.readonly` → Admin SDK Reports API (`google_reports`).
- `ediscovery.readonly` → Google Vault (`google_vault`).

The Admin SDK API must be enabled in the Cloud project (see section B, step 2).

### 2. Retention caveat (honest limitation)

Google Workspace Reports retains audit activity for approximately **180 days**.
Events older than the retained window — or never captured because the relevant
audit configuration was not enabled when they occurred — cannot be collected
and are reported as **scope limitations** in the collection's completeness
state, not silently omitted.

### 3. Vault is metadata-only (for now)

The Google Vault integration is **metadata-only**: it enumerates matters and
exports, but **downloading the export archive from the GCS export sink is a
documented follow-up and is not yet implemented**. Vault collections surface
the matter/export inventory only; the exported content itself is not retrieved.

### Revocation

Remove the domain-wide delegation entry (Admin console) and delete/disable the
service-account key (Cloud console). In EvidenceVault, _Revoke_ on the
connector deletes the stored encrypted key material and is audited.
