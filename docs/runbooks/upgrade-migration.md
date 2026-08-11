# Runbook: upgrade and migration

1. Read release notes; check for mapping-version bumps (needs reindex) and
   Prisma migrations (always applied via the migrate job/`migrate:deploy`).
2. Order: database migrations job → api → worker → web. Prisma migrations are
   forward-only in production; test on a restored copy first for majors.
3. Workers drain gracefully on SIGTERM (finish current items, checkpoint,
   exit ≤ 120 s). Deploy workers with maxSurge so collection throughput
   continues.
4. Post-deploy: /readyz green on all pods, `pnpm audit:verify`, run a demo
   search, check queue depths return to baseline.
5. Rollback: redeploy previous images. Down-migrations are not provided;
   restore the pre-upgrade PostgreSQL backup if a migration must be reverted
   (coordinate with counsel if evidence was ingested in between).
