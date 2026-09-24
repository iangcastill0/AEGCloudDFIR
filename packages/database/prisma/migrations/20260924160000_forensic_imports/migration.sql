CREATE TYPE "ForensicImportStatus" AS ENUM ('uploaded', 'analyzing', 'completed', 'failed');

CREATE TABLE "forensic_imports" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "sourceEvidenceItemId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ForensicImportStatus" NOT NULL DEFAULT 'uploaded',
  "parserVersion" TEXT NOT NULL DEFAULT '',
  "manifestKey" TEXT NOT NULL DEFAULT '',
  "manifestSha256" TEXT NOT NULL DEFAULT '',
  "artifactCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "forensic_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "forensic_imports_sourceEvidenceItemId_key"
  ON "forensic_imports"("sourceEvidenceItemId");
CREATE INDEX "forensic_imports_tenantId_createdById_createdAt_idx"
  ON "forensic_imports"("tenantId", "createdById", "createdAt");
CREATE INDEX "forensic_imports_tenantId_status_idx"
  ON "forensic_imports"("tenantId", "status");

ALTER TABLE "forensic_imports"
  ADD CONSTRAINT "forensic_imports_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forensic_imports"
  ADD CONSTRAINT "forensic_imports_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "forensic_imports"
  ADD CONSTRAINT "forensic_imports_sourceEvidenceItemId_fkey"
  FOREIGN KEY ("sourceEvidenceItemId") REFERENCES "evidence_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evidence_items" ADD COLUMN "importId" UUID;
CREATE INDEX "evidence_items_importId_idx" ON "evidence_items"("importId");
ALTER TABLE "evidence_items"
  ADD CONSTRAINT "evidence_items_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "forensic_imports"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "import_artifacts" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "importId" UUID NOT NULL,
  "parentId" UUID,
  "evidenceItemId" UUID,
  "path" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'file',
  "mimeType" TEXT NOT NULL DEFAULT '',
  "size" BIGINT NOT NULL DEFAULT 0,
  "sha256" TEXT NOT NULL DEFAULT '',
  "viewerType" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "previewKey" TEXT NOT NULL DEFAULT '',
  "previewSha256" TEXT NOT NULL DEFAULT '',
  "textIndex" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_artifacts_evidenceItemId_key"
  ON "import_artifacts"("evidenceItemId");
CREATE UNIQUE INDEX "import_artifacts_importId_path_key"
  ON "import_artifacts"("importId", "path");
CREATE INDEX "import_artifacts_tenantId_idx" ON "import_artifacts"("tenantId");
CREATE INDEX "import_artifacts_importId_parentId_id_idx"
  ON "import_artifacts"("importId", "parentId", "id");
ALTER TABLE "import_artifacts"
  ADD CONSTRAINT "import_artifacts_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "forensic_imports"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_artifacts"
  ADD CONSTRAINT "import_artifacts_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "import_artifacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_artifacts"
  ADD CONSTRAINT "import_artifacts_evidenceItemId_fkey"
  FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "import_cases" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "importId" UUID NOT NULL,
  "caseId" UUID NOT NULL,
  "addedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_cases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_cases_importId_caseId_key"
  ON "import_cases"("importId", "caseId");
CREATE INDEX "import_cases_tenantId_idx" ON "import_cases"("tenantId");
CREATE INDEX "import_cases_caseId_idx" ON "import_cases"("caseId");
ALTER TABLE "import_cases"
  ADD CONSTRAINT "import_cases_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "forensic_imports"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_cases"
  ADD CONSTRAINT "import_cases_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "forensic_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forensic_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "forensic_imports"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "import_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_artifacts"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "import_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_cases"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
