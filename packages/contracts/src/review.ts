import { z } from 'zod';
import { idempotencyKey, paginated, uuid } from './common.js';

// --- Tags ---

export const tagFamilyBehavior = z.enum(['none', 'apply_to_family', 'apply_to_descendants']);

export const createTagRequest = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  description: z.string().max(500).default(''),
  isPrivileged: z.boolean().default(false),
  isConfidential: z.boolean().default(false),
  isHidden: z.boolean().default(false),
  familyBehavior: tagFamilyBehavior.default('none'),
});

export const tagResponse = createTagRequest.extend({
  id: uuid,
  createdAt: z.string(),
  version: z.number().int(),
});

export const bulkTagRequest = z.object({
  tagId: uuid,
  evidenceItemIds: z.array(uuid).min(1).max(10_000),
  action: z.enum(['apply', 'remove']),
  note: z.string().max(1000).optional(),
  /** Optimistic concurrency on the tag definition. */
  expectedTagVersion: z.number().int().optional(),
});

// --- Saved searches ---

export const savedSearchRequest = z.object({
  name: z.string().min(1).max(120),
  caseId: uuid.optional(),
  queryText: z.string().max(4000),
  /** Validated query AST as produced by the search package. */
  queryAst: z.unknown(),
});

export const savedSearchResponse = savedSearchRequest.extend({
  id: uuid,
  createdAt: z.string(),
  version: z.number().int(),
});

// --- Cases ---

export const caseStatus = z.enum(['open', 'closed', 'archived']);

export const createCaseRequest = z.object({
  name: z.string().min(1).max(200),
  matterNumber: z.string().max(100).default(''),
  client: z.string().max(200).default(''),
  description: z.string().max(4000).default(''),
});

export const caseResponse = createCaseRequest.extend({
  id: uuid,
  status: caseStatus,
  legalHold: z.boolean(),
  createdAt: z.string(),
  version: z.number().int(),
});

export const addCaseItemsRequest = z.object({
  /** Reference-only membership; adding never copies or mutates evidence. */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('items'), evidenceItemIds: z.array(uuid).min(1).max(10_000) }),
    z.object({ kind: z.literal('tag'), tagId: uuid }),
    z.object({ kind: z.literal('saved_search'), savedSearchId: uuid }),
    /**
     * Everything a collection acquired. This is how a matter usually starts —
     * you collect first, then scope the case to what came back — and without it
     * the only way to reference a whole collection was to tag every item in it.
     */
    z.object({ kind: z.literal('collection'), collectionId: uuid }),
  ]),
  includeFamilies: z.boolean().default(true),
});

// --- Evidence detail ---

export const evidenceSummary = z.object({
  id: uuid,
  kind: z.enum(['email', 'attachment', 'file', 'folder_metadata', 'container']),
  name: z.string(),
  extension: z.string(),
  mimeType: z.string(),
  size: z.string(), // BigInt as string
  sha256: z.string(),
  custodianEmail: z.string().nullable(),
  sourcePath: z.string(),
  primaryDate: z.string().nullable(),
  processingStatus: z.string(),
  malwareStatus: z.string(),
  isApiExportDerivative: z.boolean(),
  tags: z.array(z.object({ id: uuid, name: z.string(), color: z.string() })),
});

export const evidenceListResponse = paginated(evidenceSummary);

export const chainOfCustodyEntry = z.object({
  sequence: z.string(),
  action: z.string(),
  actorDisplay: z.string(),
  occurredAt: z.string(),
  summary: z.record(z.string(), z.unknown()),
  eventHash: z.string(),
});

// --- Exports ---

export const createExportRequest = z.object({
  idempotencyKey,
  kind: z.enum(['native', 'csv']),
  name: z.string().min(1).max(200),
  caseId: uuid.optional(),
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('items'), evidenceItemIds: z.array(uuid).min(1) }),
    z.object({ kind: z.literal('tag'), tagId: uuid }),
    z.object({ kind: z.literal('saved_search'), savedSearchId: uuid }),
    z.object({ kind: z.literal('case'), caseId: uuid }),
  ]),
  includeFamilies: z.boolean().default(true),
  csv: z
    .object({
      columns: z.array(z.string()).min(1),
      delimiter: z.enum([',', '\t']).default(','),
    })
    .optional(),
  archiveSplitMb: z.number().int().min(64).max(10_240).default(2048),
});

export const exportStatusResponse = z.object({
  id: uuid,
  kind: z.enum(['native', 'csv']),
  name: z.string(),
  status: z.enum(['queued', 'running', 'verifying', 'ready', 'failed', 'cancelled']),
  statusDetail: z.string(),
  itemCount: z.number().int(),
  totalBytes: z.string(),
  verifiedAt: z.string().nullable(),
  downloadExpiresAt: z.string().nullable(),
});

/**
 * POST /exports returns the full export plus an idempotency flag: `replayed`
 * is true when the request matched an existing idempotencyKey and no new export
 * was created. Kept as an extension of the status shape so the client can parse
 * a create and a fetch with the same schema.
 */
export const createExportResponse = exportStatusResponse.extend({
  replayed: z.boolean(),
});

/**
 * GET /exports/:id/download does not stream a file — it returns short-lived
 * presigned URLs. An export can be split into several archive parts, so a single
 * redirect could never serve it, and the manifest hash must reach the user so
 * they can verify what they downloaded.
 */
export const exportDownloadResponse = z.object({
  manifestUrl: z.string(),
  archiveUrls: z.array(z.string()),
  manifestSha256: z.string(),
  expiresInSeconds: z.number().int(),
});
