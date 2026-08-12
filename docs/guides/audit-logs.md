# Audit log collection

EvidenceVault can collect provider **audit logs** alongside email and drive
evidence. Audit collection is **organization-scoped only**: it uses application
permissions (Microsoft) or domain-wide delegation (Google), never per-custodian
delegated access. A delegated-only connector cannot collect audit logs — the
connector must be in **Organization mode**. Provider-specific setup lives in the
[Microsoft Entra](microsoft-setup.md) and [Google / Workspace](google-setup.md)
guides; this page summarizes the sources and their honest limitations.

## Sources

EvidenceVault records the upstream system for every audit event. The enum
values are:

| Source                     | Provider  | Captures                                                                                                              | Permission / scope                                                       |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `o365_management_activity` | Microsoft | Unified audit content: `Audit.Exchange`, `Audit.SharePoint`, `Audit.AzureActiveDirectory`, `Audit.General`, `DLP.All` | Office 365 Management APIs → `ActivityFeed.Read` (application)           |
| `graph_directory_audits`   | Microsoft | Directory audit events (Entra ID)                                                                                     | Microsoft Graph → `AuditLog.Read.All` (application)                      |
| `graph_signins`            | Microsoft | Sign-in logs                                                                                                          | Microsoft Graph → `AuditLog.Read.All` (application)                      |
| `google_reports`           | Google    | Admin SDK Reports activities: login, drive, admin, token, mobile, user_accounts, groups, SAML applications            | DWD scope `https://www.googleapis.com/auth/admin.reports.audit.readonly` |
| `google_vault`             | Google    | Vault matter/export **metadata** (see limitation)                                                                     | DWD scope `https://www.googleapis.com/auth/ediscovery.readonly`          |

## Organization mode is required

Audit logs describe org-wide activity and are exposed by providers only through
app-level permissions (Microsoft admin consent) or domain-wide delegation
(Google super-admin grant). EvidenceVault will not attempt audit collection on a
delegated-only connector.

- **Microsoft** — enable the Unified Audit Log / Purview in the tenant, grant
  `ActivityFeed.Read` (Office 365 Management APIs) and `AuditLog.Read.All`
  (Graph) as application permissions, and obtain Global Administrator consent.
- **Google** — add `admin.reports.audit.readonly` and `ediscovery.readonly` to
  the domain-wide delegation grant for the collector service account.

## Honest limitations

- **Provider retention window.** Microsoft Purview Standard Audit and Google
  Workspace Reports both retain audit events for roughly **180 days**. Events
  older than the retained window cannot be collected.
- **Auditing must have been enabled at the time.** Events that were never
  captured — because the relevant audit configuration was disabled when they
  occurred — do not exist upstream and cannot be recovered. This is exactly the
  case the standing audit-retention truthfulness notice covers: audit logs are
  constrained by the provider retention window and the enabled audit
  configuration at the time events occurred; anything outside that is reported
  as a **scope limitation**, never silently omitted.
- **Google Vault is metadata-only (for now).** The integration enumerates
  matters and exports but does **not yet** download the export archive from the
  GCS export sink; archive download is a documented follow-up.
