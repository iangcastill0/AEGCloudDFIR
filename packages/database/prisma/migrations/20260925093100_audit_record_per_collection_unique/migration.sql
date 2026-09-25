-- Dedup audit events per collection, not per tenant.
--
-- The old unique (tenantId, system, providerRecordId) made skipDuplicates
-- throw away every event a second collection already had. The new collection
-- still stored the raw batch JSON, but Review drill-in loads records by
-- evidence item, so that batch looked empty and search had nothing to index.
-- Retries of the SAME collection still skip: they share collectionId.
--
-- Existing rows already satisfy the new unique (the old one was stricter), so
-- this is a drop-and-create. No data rewrite.
DROP INDEX IF EXISTS "audit_records_tenantId_system_providerRecordId_key";

CREATE UNIQUE INDEX "audit_records_tenantId_collectionId_system_providerRecordId_key"
  ON "audit_records"("tenantId", "collectionId", "system", "providerRecordId");
