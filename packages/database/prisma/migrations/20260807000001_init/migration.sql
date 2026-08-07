-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'pending_deletion');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('org_admin', 'case_manager', 'reviewer', 'read_only', 'production_manager', 'auditor');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('microsoft', 'google');

-- CreateEnum
CREATE TYPE "ConnectionMode" AS ENUM ('delegated', 'organization');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('pending_auth', 'connected', 'error', 'revoked');

-- CreateEnum
CREATE TYPE "SecretKind" AS ENUM ('oauth_refresh_token', 'oauth_access_token', 'service_account_key', 'client_secret');

-- CreateEnum
CREATE TYPE "CollectionKind" AS ENUM ('snapshot', 'continuous');

-- CreateEnum
CREATE TYPE "CollectionSource" AS ENUM ('email', 'drive');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('created', 'discovering', 'fetching', 'processing', 'finalizing', 'completed', 'paused', 'cancelling', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "Completeness" AS ENUM ('complete_within_selected_api_scope', 'complete_with_exceptions', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "CheckpointCursorKind" AS ENUM ('page', 'delta', 'history', 'changes', 'none');

-- CreateEnum
CREATE TYPE "CollectionItemState" AS ENUM ('discovered', 'fetching', 'preserved', 'processed', 'indexed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('unavailable_item', 'unsupported_item', 'non_downloadable', 'encrypted_item', 'rights_managed', 'corrupt_item', 'throttled_skip', 'expired_checkpoint', 'permission_denied', 'api_error', 'api_export_derivative', 'quarantined', 'other');

-- CreateEnum
CREATE TYPE "JobAttemptStatus" AS ENUM ('running', 'succeeded', 'failed', 'lost');

-- CreateEnum
CREATE TYPE "EvidenceStorageClass" AS ENUM ('original', 'quarantine');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('email', 'attachment', 'file', 'folder_metadata', 'container');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('pending', 'parsed', 'extracted', 'ocr_complete', 'preview_ready', 'indexed', 'failed', 'exception');

-- CreateEnum
CREATE TYPE "MalwareStatus" AS ENUM ('not_scanned', 'clean', 'infected', 'scan_failed');

-- CreateEnum
CREATE TYPE "RelationshipKind" AS ENUM ('attachment', 'inline_attachment', 'container_member', 'duplicate_of', 'version_of', 'source_path_ancestor', 'family');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('from', 'sender', 'to', 'cc', 'bcc', 'reply_to');

-- CreateEnum
CREATE TYPE "TextKind" AS ENUM ('body_plain', 'body_html_to_text', 'file_text', 'ocr_text', 'media_metadata');

-- CreateEnum
CREATE TYPE "PreviewKind" AS ENUM ('safe_html', 'text', 'pdf', 'thumbnail', 'page_images');

-- CreateEnum
CREATE TYPE "TagFamilyBehavior" AS ENUM ('none', 'apply_to_family', 'apply_to_descendants');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('open', 'closed', 'archived');

-- CreateEnum
CREATE TYPE "CaseRole" AS ENUM ('case_manager', 'reviewer', 'read_only', 'production_manager');

-- CreateEnum
CREATE TYPE "RedactionStage" AS ENUM ('preview', 'final');

-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('native', 'csv');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('queued', 'running', 'verifying', 'ready', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ExportItemState" AS ENUM ('pending', 'written', 'verified', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('draft', 'validating', 'submitted', 'released', 'superseded');

-- CreateEnum
CREATE TYPE "ProductionRunStatus" AS ENUM ('queued', 'rendering', 'stamping', 'verifying', 'ready', 'released', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProductionOutputKind" AS ENUM ('image', 'native', 'image_and_native', 'placeholder', 'text_only');

-- CreateEnum
CREATE TYPE "ProductionItemState" AS ENUM ('pending', 'rendered', 'stamped', 'verified', 'failed', 'placeholder');

-- CreateEnum
CREATE TYPE "ProductionExceptionSeverity" AS ENUM ('info', 'warning', 'blocking', 'security_critical');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('requested', 'approved', 'blocked', 'executed', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'dispatched', 'failed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "planQuota" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "mode" "ConnectionMode" NOT NULL,
    "label" TEXT NOT NULL,
    "externalIdentity" TEXT NOT NULL,
    "externalTenantId" TEXT NOT NULL DEFAULT '',
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ConnectorStatus" NOT NULL DEFAULT 'pending_auth',
    "statusDetail" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_secrets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "kind" "SecretKind" NOT NULL,
    "kekKeyId" TEXT NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "dekIv" BYTEA NOT NULL,
    "dekTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "cipherIv" BYTEA NOT NULL,
    "cipherTag" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "connector_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_scopes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custodians" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custodians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CollectionKind" NOT NULL DEFAULT 'snapshot',
    "sources" "CollectionSource"[],
    "scope" JSONB NOT NULL,
    "status" "CollectionStatus" NOT NULL DEFAULT 'created',
    "completeness" "Completeness",
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "manifestKey" TEXT NOT NULL DEFAULT '',
    "manifestSha256" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_custodians" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "status" "CollectionStatus" NOT NULL DEFAULT 'created',

    CONSTRAINT "collection_custodians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_checkpoints" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "source" "CollectionSource" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "cursorKind" "CheckpointCursorKind" NOT NULL,
    "cursor" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "source" "CollectionSource" NOT NULL,
    "providerItemId" TEXT NOT NULL,
    "providerImmutableId" TEXT NOT NULL DEFAULT '',
    "state" "CollectionItemState" NOT NULL DEFAULT 'discovered',
    "evidenceItemId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_exceptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "custodianId" UUID,
    "source" "CollectionSource",
    "providerItemId" TEXT NOT NULL DEFAULT '',
    "kind" "ExceptionKind" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "JobAttemptStatus" NOT NULL,
    "error" TEXT NOT NULL DEFAULT '',
    "workerId" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_blobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "providerChecksums" JSONB NOT NULL DEFAULT '{}',
    "storageClass" "EvidenceStorageClass" NOT NULL DEFAULT 'original',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "custodianId" UUID,
    "collectionId" UUID,
    "blobId" UUID,
    "kind" "EvidenceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT NOT NULL DEFAULT '',
    "mimeType" TEXT NOT NULL DEFAULT '',
    "size" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL DEFAULT '',
    "provider" "Provider",
    "providerItemId" TEXT NOT NULL DEFAULT '',
    "providerImmutableId" TEXT NOT NULL DEFAULT '',
    "sourcePath" TEXT NOT NULL DEFAULT '',
    "sourceLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isApiExportDerivative" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'pending',
    "processingDetail" TEXT NOT NULL DEFAULT '',
    "malwareStatus" "MalwareStatus" NOT NULL DEFAULT 'not_scanned',
    "primaryDate" TIMESTAMP(3),
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceModifiedAt" TIMESTAMP(3),
    "sourceTimezoneOffset" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evidence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "providerVersionId" TEXT NOT NULL,
    "versionLabel" TEXT NOT NULL DEFAULT '',
    "modifiedAt" TIMESTAMP(3),
    "modifiedBy" TEXT NOT NULL DEFAULT '',
    "size" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_relationships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "childId" UUID NOT NULL,
    "kind" "RelationshipKind" NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_metadata" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "messageId" TEXT NOT NULL DEFAULT '',
    "inReplyTo" TEXT NOT NULL DEFAULT '',
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "threadId" TEXT NOT NULL DEFAULT '',
    "conversationId" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "rawDateHeader" TEXT NOT NULL DEFAULT '',
    "folder" TEXT NOT NULL DEFAULT '',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bccPresent" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "bodyPlain" TEXT NOT NULL DEFAULT '',
    "bodyHtmlToText" TEXT NOT NULL DEFAULT '',
    "smimeType" TEXT NOT NULL DEFAULT '',
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "email_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_participants" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "rawName" TEXT NOT NULL DEFAULT '',
    "rawAddress" TEXT NOT NULL DEFAULT '',
    "normalizedAddress" TEXT NOT NULL DEFAULT '',
    "domain" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "email_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "headers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rawName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "headers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_metadata" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "driveId" TEXT NOT NULL DEFAULT '',
    "driveName" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "parentProviderId" TEXT NOT NULL DEFAULT '',
    "webUrl" TEXT NOT NULL DEFAULT '',
    "owners" JSONB NOT NULL DEFAULT '[]',
    "permissionsSummary" JSONB NOT NULL DEFAULT '[]',
    "sharedWithSummary" JSONB NOT NULL DEFAULT '[]',
    "isTrashed" BOOLEAN NOT NULL DEFAULT false,
    "isSharedDrive" BOOLEAN NOT NULL DEFAULT false,
    "sourceNativeMimeType" TEXT NOT NULL DEFAULT '',
    "exportFormat" TEXT NOT NULL DEFAULT '',
    "revisionCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "drive_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_texts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "kind" "TextKind" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "extractorName" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_pages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "boxes" JSONB NOT NULL DEFAULT '[]',
    "engineName" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previews" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "kind" "PreviewKind" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatorName" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "previews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "malware_scans" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "engineName" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "signatureVersion" TEXT NOT NULL,
    "result" "MalwareStatus" NOT NULL,
    "signatureName" TEXT NOT NULL DEFAULT '',
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "malware_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "description" TEXT NOT NULL DEFAULT '',
    "isPrivileged" BOOLEAN NOT NULL DEFAULT false,
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "familyBehavior" "TagFamilyBehavior" NOT NULL DEFAULT 'none',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_assignments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "propagatedFromId" UUID,
    "assignedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tagAssignmentId" UUID NOT NULL,
    "authorId" UUID,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_searches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID,
    "name" TEXT NOT NULL,
    "queryAst" JSONB NOT NULL,
    "queryText" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "matterNumber" TEXT NOT NULL DEFAULT '',
    "client" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "status" "CaseStatus" NOT NULL DEFAULT 'open',
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "legalHoldSetAt" TIMESTAMP(3),
    "legalHoldSetById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_members" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "role" "CaseRole" NOT NULL DEFAULT 'reviewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "addedById" UUID,
    "addedVia" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "authorId" UUID,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "case_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redactions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "caseId" UUID,
    "stage" "RedactionStage" NOT NULL DEFAULT 'preview',
    "pageNumber" INTEGER NOT NULL,
    "rect" JSONB NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#000000',
    "label" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "redactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL DEFAULT 0,
    "rect" JSONB NOT NULL DEFAULT '{}',
    "text" TEXT NOT NULL,
    "authorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID,
    "kind" "ExportKind" NOT NULL,
    "name" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'queued',
    "statusDetail" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "outputPrefix" TEXT NOT NULL DEFAULT '',
    "manifestSha256" TEXT NOT NULL DEFAULT '',
    "verifiedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "exportId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "archivePath" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL DEFAULT '',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "state" "ExportItemState" NOT NULL DEFAULT 'pending',
    "error" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "export_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ProductionStatus" NOT NULL DEFAULT 'draft',
    "draftParameters" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "productions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_selections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "inverted" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_profiles" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productionId" UUID NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "frozenParameters" JSONB NOT NULL,
    "selectionSnapshotKey" TEXT NOT NULL DEFAULT '',
    "selectionSnapshotSha256" TEXT NOT NULL DEFAULT '',
    "status" "ProductionRunStatus" NOT NULL DEFAULT 'queued',
    "statusDetail" TEXT NOT NULL DEFAULT '',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "acknowledgedWarnings" JSONB NOT NULL DEFAULT '[]',
    "outputPrefix" TEXT NOT NULL DEFAULT '',
    "manifestSha256" TEXT NOT NULL DEFAULT '',
    "batesStart" TEXT NOT NULL DEFAULT '',
    "batesEnd" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productionRunId" UUID NOT NULL,
    "evidenceItemId" UUID NOT NULL,
    "sortIndex" INTEGER NOT NULL,
    "begBates" TEXT NOT NULL DEFAULT '',
    "endBates" TEXT NOT NULL DEFAULT '',
    "begAttach" TEXT NOT NULL DEFAULT '',
    "endAttach" TEXT NOT NULL DEFAULT '',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "outputKind" "ProductionOutputKind" NOT NULL,
    "imagePaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nativePath" TEXT NOT NULL DEFAULT '',
    "textPath" TEXT NOT NULL DEFAULT '',
    "placeholderReason" TEXT NOT NULL DEFAULT '',
    "state" "ProductionItemState" NOT NULL DEFAULT 'pending',
    "error" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "production_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_exceptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productionRunId" UUID NOT NULL,
    "evidenceItemId" UUID,
    "code" TEXT NOT NULL,
    "severity" "ProductionExceptionSeverity" NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "overriddenById" UUID,
    "overriddenAt" TIMESTAMP(3),
    "secondConfirmationById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bates_reservations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productionRunId" UUID NOT NULL,
    "prefix" TEXT NOT NULL,
    "suffix" TEXT NOT NULL DEFAULT '',
    "digits" INTEGER NOT NULL,
    "startNumber" BIGINT NOT NULL,
    "endNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bates_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "retainDays" INTEGER NOT NULL,
    "appliesTo" TEXT NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DeletionStatus" NOT NULL DEFAULT 'requested',
    "requestedById" UUID,
    "approvedById" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "blockedReason" TEXT NOT NULL DEFAULT '',
    "manifestKey" TEXT NOT NULL DEFAULT '',
    "manifestSha256" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "actorUserId" TEXT NOT NULL DEFAULT '',
    "actorDisplay" TEXT NOT NULL DEFAULT '',
    "effectiveRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "requestId" TEXT NOT NULL DEFAULT '',
    "ipAddress" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevEventHash" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_issuer_subject_key" ON "users"("issuer", "subject");

-- CreateIndex
CREATE INDEX "memberships_userId_idx" ON "memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenantId_userId_key" ON "memberships"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "role_assignments_tenantId_idx" ON "role_assignments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_membershipId_role_key" ON "role_assignments"("membershipId", "role");

-- CreateIndex
CREATE INDEX "connector_accounts_tenantId_idx" ON "connector_accounts"("tenantId");

-- CreateIndex
CREATE INDEX "connector_secrets_tenantId_idx" ON "connector_secrets"("tenantId");

-- CreateIndex
CREATE INDEX "connector_secrets_connectorAccountId_idx" ON "connector_secrets"("connectorAccountId");

-- CreateIndex
CREATE INDEX "connector_scopes_tenantId_idx" ON "connector_scopes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_scopes_connectorAccountId_scope_key" ON "connector_scopes"("connectorAccountId", "scope");

-- CreateIndex
CREATE INDEX "custodians_tenantId_idx" ON "custodians"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "custodians_connectorAccountId_externalId_key" ON "custodians"("connectorAccountId", "externalId");

-- CreateIndex
CREATE INDEX "collections_tenantId_status_idx" ON "collections"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "collections_tenantId_idempotencyKey_key" ON "collections"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "collection_custodians_tenantId_idx" ON "collection_custodians"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_custodians_collectionId_custodianId_key" ON "collection_custodians"("collectionId", "custodianId");

-- CreateIndex
CREATE INDEX "collection_checkpoints_tenantId_idx" ON "collection_checkpoints"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_checkpoints_collectionId_custodianId_source_scop_key" ON "collection_checkpoints"("collectionId", "custodianId", "source", "scopeKey");

-- CreateIndex
CREATE INDEX "collection_items_tenantId_idx" ON "collection_items"("tenantId");

-- CreateIndex
CREATE INDEX "collection_items_collectionId_state_idx" ON "collection_items"("collectionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "collection_items_collectionId_custodianId_source_providerIt_key" ON "collection_items"("collectionId", "custodianId", "source", "providerItemId");

-- CreateIndex
CREATE INDEX "collection_exceptions_tenantId_idx" ON "collection_exceptions"("tenantId");

-- CreateIndex
CREATE INDEX "collection_exceptions_collectionId_kind_idx" ON "collection_exceptions"("collectionId", "kind");

-- CreateIndex
CREATE INDEX "job_attempts_tenantId_idx" ON "job_attempts"("tenantId");

-- CreateIndex
CREATE INDEX "job_attempts_queue_jobId_idx" ON "job_attempts"("queue", "jobId");

-- CreateIndex
CREATE INDEX "evidence_blobs_tenantId_idx" ON "evidence_blobs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_blobs_tenantId_sha256_key" ON "evidence_blobs"("tenantId", "sha256");

-- CreateIndex
CREATE INDEX "evidence_items_tenantId_idx" ON "evidence_items"("tenantId");

-- CreateIndex
CREATE INDEX "evidence_items_tenantId_sha256_idx" ON "evidence_items"("tenantId", "sha256");

-- CreateIndex
CREATE INDEX "evidence_items_tenantId_custodianId_idx" ON "evidence_items"("tenantId", "custodianId");

-- CreateIndex
CREATE INDEX "evidence_items_collectionId_idx" ON "evidence_items"("collectionId");

-- CreateIndex
CREATE INDEX "evidence_versions_tenantId_idx" ON "evidence_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_versions_evidenceItemId_providerVersionId_key" ON "evidence_versions"("evidenceItemId", "providerVersionId");

-- CreateIndex
CREATE INDEX "evidence_relationships_tenantId_idx" ON "evidence_relationships"("tenantId");

-- CreateIndex
CREATE INDEX "evidence_relationships_childId_idx" ON "evidence_relationships"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_relationships_parentId_childId_kind_key" ON "evidence_relationships"("parentId", "childId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "email_metadata_evidenceItemId_key" ON "email_metadata"("evidenceItemId");

-- CreateIndex
CREATE INDEX "email_metadata_tenantId_idx" ON "email_metadata"("tenantId");

-- CreateIndex
CREATE INDEX "email_metadata_tenantId_messageId_idx" ON "email_metadata"("tenantId", "messageId");

-- CreateIndex
CREATE INDEX "email_participants_tenantId_idx" ON "email_participants"("tenantId");

-- CreateIndex
CREATE INDEX "email_participants_evidenceItemId_role_idx" ON "email_participants"("evidenceItemId", "role");

-- CreateIndex
CREATE INDEX "email_participants_tenantId_normalizedAddress_idx" ON "email_participants"("tenantId", "normalizedAddress");

-- CreateIndex
CREATE INDEX "headers_tenantId_idx" ON "headers"("tenantId");

-- CreateIndex
CREATE INDEX "headers_evidenceItemId_position_idx" ON "headers"("evidenceItemId", "position");

-- CreateIndex
CREATE INDEX "headers_tenantId_name_idx" ON "headers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "drive_metadata_evidenceItemId_key" ON "drive_metadata"("evidenceItemId");

-- CreateIndex
CREATE INDEX "drive_metadata_tenantId_idx" ON "drive_metadata"("tenantId");

-- CreateIndex
CREATE INDEX "extracted_texts_tenantId_idx" ON "extracted_texts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_texts_evidenceItemId_kind_version_key" ON "extracted_texts"("evidenceItemId", "kind", "version");

-- CreateIndex
CREATE INDEX "ocr_pages_tenantId_idx" ON "ocr_pages"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ocr_pages_evidenceItemId_pageNumber_key" ON "ocr_pages"("evidenceItemId", "pageNumber");

-- CreateIndex
CREATE INDEX "previews_tenantId_idx" ON "previews"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "previews_evidenceItemId_kind_version_key" ON "previews"("evidenceItemId", "kind", "version");

-- CreateIndex
CREATE INDEX "malware_scans_tenantId_idx" ON "malware_scans"("tenantId");

-- CreateIndex
CREATE INDEX "malware_scans_evidenceItemId_idx" ON "malware_scans"("evidenceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenantId_name_key" ON "tags"("tenantId", "name");

-- CreateIndex
CREATE INDEX "tag_assignments_tenantId_idx" ON "tag_assignments"("tenantId");

-- CreateIndex
CREATE INDEX "tag_assignments_evidenceItemId_idx" ON "tag_assignments"("evidenceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_assignments_tagId_evidenceItemId_key" ON "tag_assignments"("tagId", "evidenceItemId");

-- CreateIndex
CREATE INDEX "tag_notes_tenantId_idx" ON "tag_notes"("tenantId");

-- CreateIndex
CREATE INDEX "saved_searches_tenantId_idx" ON "saved_searches"("tenantId");

-- CreateIndex
CREATE INDEX "cases_tenantId_status_idx" ON "cases"("tenantId", "status");

-- CreateIndex
CREATE INDEX "case_members_tenantId_idx" ON "case_members"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "case_members_caseId_membershipId_key" ON "case_members"("caseId", "membershipId");

-- CreateIndex
CREATE INDEX "case_items_tenantId_idx" ON "case_items"("tenantId");

-- CreateIndex
CREATE INDEX "case_items_evidenceItemId_idx" ON "case_items"("evidenceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "case_items_caseId_evidenceItemId_key" ON "case_items"("caseId", "evidenceItemId");

-- CreateIndex
CREATE INDEX "case_notes_tenantId_idx" ON "case_notes"("tenantId");

-- CreateIndex
CREATE INDEX "redactions_tenantId_idx" ON "redactions"("tenantId");

-- CreateIndex
CREATE INDEX "redactions_evidenceItemId_stage_idx" ON "redactions"("evidenceItemId", "stage");

-- CreateIndex
CREATE INDEX "annotations_tenantId_idx" ON "annotations"("tenantId");

-- CreateIndex
CREATE INDEX "exports_tenantId_status_idx" ON "exports"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exports_tenantId_idempotencyKey_key" ON "exports"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "export_items_tenantId_idx" ON "export_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "export_items_exportId_evidenceItemId_key" ON "export_items"("exportId", "evidenceItemId");

-- CreateIndex
CREATE INDEX "productions_tenantId_status_idx" ON "productions"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "productions_tenantId_idempotencyKey_key" ON "productions"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "production_selections_tenantId_idx" ON "production_selections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "production_profiles_tenantId_name_key" ON "production_profiles"("tenantId", "name");

-- CreateIndex
CREATE INDEX "production_runs_tenantId_status_idx" ON "production_runs"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_runs_productionId_runNumber_key" ON "production_runs"("productionId", "runNumber");

-- CreateIndex
CREATE INDEX "production_items_tenantId_idx" ON "production_items"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "production_items_productionRunId_evidenceItemId_key" ON "production_items"("productionRunId", "evidenceItemId");

-- CreateIndex
CREATE INDEX "production_exceptions_tenantId_idx" ON "production_exceptions"("tenantId");

-- CreateIndex
CREATE INDEX "production_exceptions_productionRunId_severity_idx" ON "production_exceptions"("productionRunId", "severity");

-- CreateIndex
CREATE INDEX "bates_reservations_tenantId_prefix_idx" ON "bates_reservations"("tenantId", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_tenantId_name_key" ON "retention_policies"("tenantId", "name");

-- CreateIndex
CREATE INDEX "deletion_requests_tenantId_status_idx" ON "deletion_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_tenantId_action_idx" ON "audit_events"("tenantId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_tenantId_sequence_key" ON "audit_events"("tenantId", "sequence");

-- CreateIndex
CREATE INDEX "outbox_events_status_createdAt_idx" ON "outbox_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_tenantId_idx" ON "outbox_events"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_topic_dedupKey_key" ON "outbox_events"("topic", "dedupKey");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_accounts" ADD CONSTRAINT "connector_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_secrets" ADD CONSTRAINT "connector_secrets_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_scopes" ADD CONSTRAINT "connector_scopes_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custodians" ADD CONSTRAINT "custodians_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custodians" ADD CONSTRAINT "custodians_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_custodians" ADD CONSTRAINT "collection_custodians_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_custodians" ADD CONSTRAINT "collection_custodians_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "custodians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_checkpoints" ADD CONSTRAINT "collection_checkpoints_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_exceptions" ADD CONSTRAINT "collection_exceptions_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_blobs" ADD CONSTRAINT "evidence_blobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_blobId_fkey" FOREIGN KEY ("blobId") REFERENCES "evidence_blobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "custodians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_relationships" ADD CONSTRAINT "evidence_relationships_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_relationships" ADD CONSTRAINT "evidence_relationships_childId_fkey" FOREIGN KEY ("childId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_metadata" ADD CONSTRAINT "email_metadata_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_participants" ADD CONSTRAINT "email_participants_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "headers" ADD CONSTRAINT "headers_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive_metadata" ADD CONSTRAINT "drive_metadata_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_texts" ADD CONSTRAINT "extracted_texts_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_pages" ADD CONSTRAINT "ocr_pages_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previews" ADD CONSTRAINT "previews_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "malware_scans" ADD CONSTRAINT "malware_scans_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_notes" ADD CONSTRAINT "tag_notes_tagAssignmentId_fkey" FOREIGN KEY ("tagAssignmentId") REFERENCES "tag_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redactions" ADD CONSTRAINT "redactions_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productions" ADD CONSTRAINT "productions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productions" ADD CONSTRAINT "productions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_selections" ADD CONSTRAINT "production_selections_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_productionId_fkey" FOREIGN KEY ("productionId") REFERENCES "productions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_productionRunId_fkey" FOREIGN KEY ("productionRunId") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "evidence_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_exceptions" ADD CONSTRAINT "production_exceptions_productionRunId_fkey" FOREIGN KEY ("productionRunId") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bates_reservations" ADD CONSTRAINT "bates_reservations_productionRunId_fkey" FOREIGN KEY ("productionRunId") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

