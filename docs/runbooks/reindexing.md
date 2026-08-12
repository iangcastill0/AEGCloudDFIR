# Runbook: search reindexing

Rebuilds OpenSearch from PostgreSQL + S3 truth (index is disposable).

When: mapping version bump, index corruption/loss, tenant restore.

1. `scripts/reindex --tenant <id>` (or all tenants). Internals: creates
   `cdfir-evidence-v{N+1}`, streams batches from PostgreSQL, swaps the
   alias atomically on success; on any batch error the alias is NOT swapped.
2. Monitor: bulk error count in worker logs; dead-letter queue for per-doc
   failures.
3. Verify: run acceptance search set (subject/from/hash/ocr samples) and
   compare totals to `SELECT count(*) FROM evidence_items WHERE ...`.
4. Delete the old index after a soak period.
