import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().datetime();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const forensicImportStatus = z.enum(['uploaded', 'analyzing', 'completed', 'failed']);

export const importSummary = z.object({
  id: uuid,
  name: z.string().min(1).max(255),
  status: forensicImportStatus,
  sourceEvidenceItemId: uuid,
  createdById: uuid,
  parserVersion: z.string(),
  artifactCount: z.number().int().nonnegative(),
  error: z.string(),
  caseIds: z.array(uuid),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const importDetailResponse = importSummary;

export const importListResponse = z.object({
  items: z.array(importSummary),
  nextCursor: uuid.nullable(),
});

export const importArtifact = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  evidenceItemId: uuid.nullable(),
  path: z.string().min(1).max(2000),
  name: z.string().min(1).max(500),
  kind: z.enum(['file', 'directory']),
  mimeType: z.string().max(255),
  size: z.string().regex(/^\d+$/),
  sha256: z.union([sha256, z.literal('')]),
  viewerType: z.string().max(64),
  metadata: z.record(z.string(), z.unknown()),
  preview: z.unknown(),
  textIndex: z.string(),
});

export const importArtifactPageResponse = z.object({
  items: z.array(importArtifact),
  nextCursor: uuid.nullable(),
});

export const importSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});

export const importSearchHit = z.object({
  artifact: importArtifact.omit({ preview: true, textIndex: true }),
  matchLocation: z.enum(['name', 'path', 'content']),
  snippet: z.string().max(400),
});

export const importSearchResponse = z.object({
  items: z.array(importSearchHit),
  nextCursor: uuid.nullable(),
});

export const importUploadResponse = importSummary;

export const attachImportRequest = z.object({
  caseId: uuid,
});

export const attachImportResponse = z.object({
  importId: uuid,
  caseId: uuid,
  itemsAdded: z.number().int().nonnegative(),
});

export type ForensicImportStatus = z.infer<typeof forensicImportStatus>;
export type ImportSummary = z.infer<typeof importSummary>;
export type ImportArtifact = z.infer<typeof importArtifact>;
export type ImportSearchQuery = z.infer<typeof importSearchQuery>;
export type ImportSearchHit = z.infer<typeof importSearchHit>;
export type AttachImportRequest = z.infer<typeof attachImportRequest>;
