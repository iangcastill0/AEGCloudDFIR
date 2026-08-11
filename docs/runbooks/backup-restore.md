# Runbook: backup and restore

## What to back up
| Store | Method | Frequency |
|---|---|---|
| PostgreSQL | `pg_dump -Fc evidencevault` (or WAL archiving/PITR) | continuous WAL + nightly base |
| Object store | Wasabi bucket versioning + (optionally) cross-region replication | continuous |
| OpenSearch | none required — rebuildable index | — |
| Redis | none required — transient job state (outbox re-dispatches) | — |
| Secrets | KEK master key, session secret, OIDC client secret in your secret manager | on change |

## Restore order
1. Restore PostgreSQL to target time.
2. Verify audit chains: `pnpm audit:verify` (exit 0).
3. Point services at the object store (objects are content-addressed; no restore needed unless the bucket itself was lost — then restore versioned objects/replica).
4. Reconcile: run `scripts/reindex` (rebuilds OpenSearch from PostgreSQL+S3 truth).
5. Re-run any collections that were mid-flight: their checkpoints resume automatically once workers start; verify with the collection status page.

## Integrity verification after restore
- `pnpm audit:verify` per tenant.
- Spot-verify N random evidence blobs: compare stored sha256 against a fresh hash of the object (Admin → Storage → verify sample, or scripts).
