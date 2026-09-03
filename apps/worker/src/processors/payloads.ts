import { z } from 'zod';

/**
 * Job payload contracts shared with apps/api (the outbox producer).
 * The dispatcher merges `tenantId` and `outboxEventId` into every payload;
 * zod objects strip unknown keys, so extra bookkeeping fields are tolerated.
 */

const uuid = z.string().uuid();

export const collectionSourceValue = z.enum(['email', 'drive', 'chat', 'audit']);

export const discoverPayload = z.object({
  tenantId: uuid,
  collectionId: uuid,
});
export type DiscoverPayload = z.infer<typeof discoverPayload>;

export const fetchPagePayload = z.object({
  tenantId: uuid,
  collectionId: uuid,
  custodianId: uuid,
  source: collectionSourceValue,
  scopeKey: z.string().min(1),
});
export type FetchPagePayload = z.infer<typeof fetchPagePayload>;

/**
 * Serialized connector DriveEntry carried in the fetch-item payload so the
 * worker never has to re-list a page to download one file. Matches the
 * DriveEntry shape from @aeg-clouddfir/connectors.
 */
export const driveEntryPayload = z.object({
  providerItemId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().optional(),
  path: z.string(),
  parentId: z.string().optional(),
  checksums: z.record(z.string(), z.string()).default({}),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
  createdBy: z.string().optional(),
  modifiedBy: z.string().optional(),
  trashed: z.boolean().optional(),
  sharedSummary: z.unknown().optional(),
  driveId: z.string().optional(),
  isFolder: z.boolean(),
  downloadable: z.boolean(),
  googleNativeType: z.string().optional(),
  versionId: z.string().optional(),
});
export type DriveEntryPayload = z.infer<typeof driveEntryPayload>;

export const fetchItemPayload = z.object({
  tenantId: uuid,
  collectionId: uuid,
  custodianId: uuid,
  source: collectionSourceValue,
  providerItemId: z.string().min(1),
  /** Present for drive items only. */
  entry: driveEntryPayload.optional(),
  /**
   * Present for chat items only: the provider's message, exactly as returned.
   *
   * A field of its own rather than reusing `entry`. Reusing it was tried and
   * failed on the first real run: the drive schema requires providerItemId,
   * name and mimeType, a Slack message has none of them, and every item
   * dead-lettered on a validation error that could never pass. A Slack message
   * is not a drive entry, and a cast that says otherwise only moves the lie
   * from the type checker to runtime.
   *
   * Unknown rather than a shape: the value of preserving the raw message is
   * that it is complete, including fields this version has never seen.
   */
  message: z.unknown().optional(),
});
export type FetchItemPayload = z.infer<typeof fetchItemPayload>;

/**
 * pst.extract: reconstruct messages from one preserved uploaded container
 * (PST/OST). The container evidence item stays the immutable original.
 */
export const pstExtractPayload = z.object({
  tenantId: uuid,
  collectionId: uuid,
  custodianId: uuid,
  evidenceItemId: uuid,
});
export type PstExtractPayload = z.infer<typeof pstExtractPayload>;

export const finalizePayload = z.object({
  tenantId: uuid,
  collectionId: uuid,
});
export type FinalizePayload = z.infer<typeof finalizePayload>;

export const evidenceStagePayload = z.object({
  tenantId: uuid,
  evidenceItemId: uuid,
  version: z.number().int().min(1).default(1),
});
export type EvidenceStagePayload = z.infer<typeof evidenceStagePayload>;

export const exportRunPayload = z.object({
  tenantId: uuid,
  exportId: uuid,
});
export type ExportRunPayload = z.infer<typeof exportRunPayload>;

export const productionRunPayload = z.object({
  tenantId: uuid,
  productionRunId: uuid,
});
export type ProductionRunPayload = z.infer<typeof productionRunPayload>;

export const tenantOnlyPayload = z.object({ tenantId: uuid });
