# Runbook: disaster recovery

RPO/RTO depend on your PostgreSQL replication and Wasabi replication choices;
document your targets here after deployment.

1. **Postgres loss** → restore from WAL/PITR (see backup-restore). Outbox rows
   in status pending re-dispatch automatically; BullMQ jobIds dedupe replays.
2. **Redis loss** → safe. Restart workers; the outbox dispatcher re-enqueues
   anything not yet dispatched; consumers are idempotent.
3. **OpenSearch loss** → `scripts/reindex` from truth. Search is degraded, not
   evidence-affecting, in the interim.
4. **Object store regional outage** → read-only degradation: previews/downloads
   fail, metadata/search still work. Collections pause on S3 errors and resume.
5. **Full site loss** → new cluster: apply k8s base, restore Postgres, point at
   the (replicated) buckets, run migrations job (no-op if current), reindex.

After any DR event: run audit verification, then a completeness re-check on
recent collections, and record the event in your incident log.
