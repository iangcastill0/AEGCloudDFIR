-- A digest for each archive part of a native export.
--
-- The manifest already hashes every evidence item, which proves the CONTENTS
-- once you have extracted them. It says nothing about whether a 2 GiB part
-- arrived intact. A 130 GiB export is 65 parts, and without this the only way
-- to detect a truncated part was to unzip all of it and hash 434,878 items.
--
-- The worker already computed this digest for every part and threw it away:
-- putDerivative returns { objectKey, sha256, size } and rotatePart kept only
-- the object key.
--
-- Deliberately its own table rather than a field inside manifest.json. The
-- manifest is written INSIDE the final archive part, so using it to verify the
-- parts would mean trusting a part to vouch for itself.
--
-- Rows exist only for exports produced after this migration. Older exports
-- (there is a 130 GiB one on production) have none, and the download path must
-- treat a missing digest as "cannot verify" rather than as "verified".
-- scripts backfill-export-part-hashes.ts fills them in by re-reading the parts.
CREATE TABLE "export_parts" (
  "id"         UUID NOT NULL,
  "tenantId"   UUID NOT NULL,
  "exportId"   UUID NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "objectKey"  TEXT NOT NULL,
  "sha256"     TEXT NOT NULL,
  "sizeBytes"  BIGINT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "export_parts_pkey" PRIMARY KEY ("id")
);

-- One row per part, so a re-run of a part upsert cannot double-count.
CREATE UNIQUE INDEX "export_parts_exportId_partNumber_key"
  ON "export_parts"("exportId", "partNumber");

CREATE INDEX "export_parts_tenantId_idx" ON "export_parts"("tenantId");

ALTER TABLE "export_parts"
  ADD CONSTRAINT "export_parts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE matches export_items: parts are meaningless without their export.
ALTER TABLE "export_parts"
  ADD CONSTRAINT "export_parts_exportId_fkey"
  FOREIGN KEY ("exportId") REFERENCES "exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation lives in the database, not the service layer. FORCE so the
-- table owner is bound by it too; without FORCE, the owner bypasses the policy
-- and a missing withTenantContext would leak silently.
ALTER TABLE "export_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "export_parts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "export_parts"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
