# Runbook: audit-chain verification

- Scheduled: run `pnpm audit:verify` (all tenants) nightly in CI/cron; alert
  on non-zero exit.
- On demand per tenant: `pnpm audit:verify -- --tenant <uuid>`, or in-app
  (org_admin/auditor): GET /api/v1/audit/verify.
- Output on failure names the first invalid sequence and reason (gap,
  prev-hash mismatch, content-hash mismatch). Treat any failure as a
  security incident: freeze the database (read-only), snapshot, and follow
  incident-response.md. The chain is per-tenant; other tenants' chains remain
  independently verifiable.
- After a legitimate restore to an earlier point in time, chains verify but
  end earlier; document the restore window in the matter file.
