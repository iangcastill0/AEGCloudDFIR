# Runbook: incident response

Severity guide: S1 evidence integrity/confidentiality suspected; S2 service
down; S3 degraded (search stale, OCR backlog).

## S1 — suspected breach or tampering

1. Freeze: scale api to 0 (or enable maintenance mode), keep workers stopped;
   snapshot PostgreSQL and bucket versioning state.
2. Verify audit chains per tenant; export the audit log for the window.
3. Rotate ALL credentials (see key-rotation) and Authentik sessions.
4. Review object-store access logs (enable Wasabi bucket logging ahead of
   time) for original-key reads outside app credentials.
5. Notify affected tenants per your contractual/legal obligations (counsel).
6. Postmortem with timeline reconstructed from audit events (hash-chained).

## Platform-operator access (break-glass) — design

Routine operator access to tenant evidence does not exist (no API path;
platform context has no evidence-table RLS policy). If a court order or
recovery scenario requires it, the documented-but-disabled break-glass path
is: a dedicated database role with a time-boxed grant, enabled by two
operators (four-eyes) via infrastructure change, every access logged at the
database level (pgaudit recommended) and disclosed to the tenant. Keep it
disabled by default; enabling it is itself an S1-logged event.
