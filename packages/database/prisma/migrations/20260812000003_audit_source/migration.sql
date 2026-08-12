-- CreateEnum
CREATE TYPE "AuditSystem" AS ENUM ('o365_management_activity', 'graph_directory_audits', 'graph_signins', 'google_reports', 'google_vault');

-- AlterEnum
ALTER TYPE "CollectionSource" ADD VALUE 'audit';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EvidenceKind" ADD VALUE 'audit_record';
ALTER TYPE "EvidenceKind" ADD VALUE 'audit_batch';

-- CreateTable
CREATE TABLE "audit_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "collectionId" UUID,
    "provider" "Provider" NOT NULL,
    "system" "AuditSystem" NOT NULL,
    "providerRecordId" TEXT NOT NULL,
    "workload" TEXT NOT NULL DEFAULT '',
    "operation" TEXT NOT NULL DEFAULT '',
    "recordType" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT NOT NULL DEFAULT '',
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "actorIp" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "targetType" TEXT NOT NULL DEFAULT '',
    "resultStatus" TEXT NOT NULL DEFAULT '',
    "occurredAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_records_tenantId_idx" ON "audit_records"("tenantId");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_occurredAt_idx" ON "audit_records"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_actorEmail_idx" ON "audit_records"("tenantId", "actorEmail");

-- CreateIndex
CREATE INDEX "audit_records_tenantId_operation_idx" ON "audit_records"("tenantId", "operation");

-- CreateIndex
CREATE INDEX "audit_records_evidenceItemId_idx" ON "audit_records"("evidenceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_records_tenantId_system_providerRecordId_key" ON "audit_records"("tenantId", "system", "providerRecordId");

-- AddForeignKey
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security for the new tenant-owned table (matches the pattern in
-- 20260807000002). Fail-closed: NULLIF guards empty GUC values.
ALTER TABLE "audit_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_records"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
