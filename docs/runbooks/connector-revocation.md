# Runbook: connector revocation (offboarding a source)

1. EvidenceVault: Connectors → Revoke. Effects: status `revoked`, encrypted
   refresh-token/service-account rows deleted, audited (`connector.revoked`).
   Evidence already preserved is unaffected.
2. Provider side (belt and braces):
   - Microsoft delegated: user removes the app at myaccount.microsoft.com →
     App permissions. Org mode: remove the service principal / role assignment
     (`Remove-ManagementRoleAssignment`) or delete admin consent in Entra.
   - Google delegated: myaccount.google.com/permissions. Org mode: remove the
     domain-wide delegation entry in Admin console and disable the service
     account key in Cloud console.
3. Active collections on that connector fail with permission_denied exceptions
   and finalize as `partial`/`complete_with_exceptions` — expected and honest.
