# Runbook: disaster recovery

RPO/RTO depend on your PostgreSQL replication and Wasabi replication choices;
document your targets here after deployment.

1. **Postgres loss** → restore from WAL/PITR (see backup-restore). Outbox rows
   in status pending re-dispatch automatically; BullMQ jobIds dedupe replays.
2. **Redis loss** → safe **only for work not yet dispatched**. The dispatcher
   marks an outbox row `dispatched` in the same transaction that enqueues it,
   and `(topic, dedupKey)` is unique with dispatched rows kept — so a dispatched
   job lives in Redis and nowhere else. Check before assuming:
   `SELECT count(*) FROM outbox_events WHERE status='pending'` against
   `redis-cli LLEN bull:<queue>:wait`. Measured once at 0 pending against
   245,703 queued, where losing Redis would have discarded days of extraction
   and OCR. The database is not entirely silent about it — `evidence_items`
   carries `processingStatus`, and on 2026-09-15 exactly 200,341 rows read
   `pending`, matching the 244,068 jobs then in Redis. But **nothing re-queues
   from that column**, so the record is a post-mortem, not a recovery. Restart
   workers; consumers are idempotent. See
   [server-migration](server-migration.md) for carrying Redis deliberately.
3. **OpenSearch loss** → `scripts/reindex` from truth. Search is degraded, not
   evidence-affecting, in the interim.
4. **Object store regional outage** → read-only degradation: previews/downloads
   fail, metadata/search still work. Collections pause on S3 errors and resume.
5. **Full site loss** → new cluster: apply k8s base, restore Postgres, point at
   the (replicated) buckets, run migrations job (no-op if current), reindex.

After any DR event: run audit verification, then a completeness re-check on
recent collections, and record the event in your incident log.
