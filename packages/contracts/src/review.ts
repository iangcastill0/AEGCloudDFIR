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
  /**
   * Which language queryText is written in. Stored because loading a saved
   * search re-parses the text, and the wrong parser changes its meaning.
   */
  syntax: z.enum(['simple', 'advanced']).default('simple'),
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
  // Mirrors the database EvidenceKind enum. audit_batch is the reviewable unit
  // for collected provider audit logs (its individual events are AuditRecords,
  // reached through the audit-records drill-in).
  kind: z.enum([
    'email',
    'attachment',
    'file',
    'folder_metadata',
    'container',
    'audit_record',
    'audit_batch',
    'chat_message',
    'chat_conversation',
  ]),
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
  /**
   * `pst` is NOT a native export. It re-encodes each message into Outlook's
   * format, so nothing in the file hashes to a digest anyone recorded — see
   * TRUTHFULNESS_NOTICES.pstExport. The native `.eml` digests always ship
   * alongside it, and `pst-export.ts` refuses to finish an export that has not
   * written them.
   */
  kind: z.enum(['native', 'csv', 'pst']),
  name: z.string().min(1).max(200),
  caseId: uuid.optional(),
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('items'), evidenceItemIds: z.array(uuid).min(1) }),
    z.object({ kind: z.literal('tag'), tagId: uuid }),
    z.object({ kind: z.literal('saved_search'), savedSearchId: uuid }),
    z.object({ kind: z.literal('case'), caseId: uuid }),
  ]),
  includeFamilies: z.boolean().default(true),
  /**
   * Where email attachments land in a native export.
   *
   * `inline` (the default) leaves them where they already are: inside the
   * parent `.eml`, which is RFC822 and carries them. `extracted` also writes
   * each one as its own file under a directory named after the parent, which
   * is a second copy of bytes the archive already holds — on one real 130 GiB
   * export that was 249,787 of 434,878 items and about 30 GB.
   */
  attachments: z.enum(['inline', 'extracted']).default('inline'),
  csv: z
    .object({
      columns: z.array(z.string()).min(1),
      delimiter: z.enum([',', '\t']).default(','),
    })
    .optional(),
  archiveSplitMb: z.number().int().min(64).max(10_240).default(2048),
  /**
   * Part size for a `pst` export, in MiB. Each part is a COMPLETE,
   * independently-openable PST, not a byte-range volume of one big file.
   *
   * Capped at 3,072 MiB (3 GiB) because that is what the writer can actually
   * do. Its own hard ceiling is `MaxSingleFileBytes - 128 MiB` — about
   * 3.19 GiB — and anything larger is SILENTLY clamped down to it. Letting an
   * operator ask for 10 GiB and quietly handing back 15 parts of 3.19 GiB is
   * the kind of surprise that reads as a bug in the product.
   *
   * 3 GiB is also upstream's own default, described there as the size validated
   * against real Outlook. Note that the largest PST anyone here has actually
   * opened and checked is 2.77 GiB.
   */
  pstPartMb: z.number().int().min(64).max(3072).default(3072),
});

export const exportStatusResponse = z.object({
  id: uuid,
  kind: z.enum(['native', 'csv', 'pst']),
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
  /**
   * Per-part detail, so a client can save the parts into one folder under
   * stable names and check each one as it lands.
   *
   * `sha256` is null for exports produced before part digests were recorded.
   * Null means "cannot verify", and a client must say so rather than quietly
   * presenting an unverified part as a verified one.
   */
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1),
      filename: z.string(),
      sizeBytes: z.number().int().nonnegative().nullable(),
      sha256: z.string().nullable(),
      url: z.string(),
    }),
  ),
  /** Suggested folder name, already safe for a filesystem. */
  folderName: z.string(),
  /**
   * Scoped credential that lets a download script re-sign URLs as it goes.
   * Presigned URLs last minutes; a 65-part download does not.
   */
  downloadToken: z.string(),
  downloadTokenExpiresInSeconds: z.number().int(),
});

/**
 * POST /exports/:id/download/urls — fresh presigned URLs for a script that is
 * already partway through, authenticated by the scoped download token rather
 * than a session.
 */
export const exportDownloadRefreshResponse = z.object({
  manifestUrl: z.string(),
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1),
      filename: z.string(),
      sizeBytes: z.number().int().nonnegative().nullable(),
      sha256: z.string().nullable(),
      url: z.string(),
    }),
  ),
  expiresInSeconds: z.number().int(),
});
