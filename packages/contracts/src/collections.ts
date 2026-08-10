import { z } from 'zod';
import { collectionSource, completeness, idempotencyKey, uuid } from './common.js';

/**
 * Canonical IANA timezone id. Uses Intl.supportedValuesOf so legacy
 * abbreviations like "PST" (ambiguous across jurisdictions) are rejected;
 * an explicit Area/Location id or UTC is required.
 */
const CANONICAL_TIMEZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
]);

export const timezoneId = z
  .string()
  .refine((tz) => CANONICAL_TIMEZONES.has(tz), {
    message: 'must be a canonical IANA timezone identifier (e.g. America/Chicago or UTC)',
  });

export const collectionScope = z.object({
  /** 'all_time' still means: within account/permission/API-visible scope. */
  dateRange: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all_time') }),
    z.object({
      kind: z.literal('range'),
      /** Inclusive calendar dates interpreted in `timezone`. */
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezone: timezoneId,
    }),
  ]),
  email: z
    .object({
      folderIds: z.array(z.string()).nullable(), // null = all discovered folders
      includeSpam: z.boolean().default(false),
      includeTrash: z.boolean().default(false),
      includeRecoverableItems: z.boolean().default(false),
    })
    .optional(),
  drive: z
    .object({
      driveIds: z.array(z.string()).nullable(), // null = default drive
      folderIds: z.array(z.string()).nullable(),
      includeSharedDrives: z.boolean().default(false),
      includeTrashed: z.boolean().default(false),
    })
    .optional(),
});
export type CollectionScope = z.infer<typeof collectionScope>;

export const createCollectionRequest = z.object({
  idempotencyKey,
  connectorAccountId: uuid,
  name: z.string().min(1).max(200),
  kind: z.enum(['snapshot', 'continuous']).default('snapshot'),
  sources: z.array(collectionSource).min(1),
  custodianIds: z.array(uuid).min(1),
  scope: collectionScope,
});
export type CreateCollectionRequest = z.infer<typeof createCollectionRequest>;

export const collectionStatusValue = z.enum([
  'created',
  'discovering',
  'fetching',
  'processing',
  'finalizing',
  'completed',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
]);

export const custodianProgress = z.object({
  custodianId: uuid,
  custodianEmail: z.string(),
  source: collectionSource,
  discovered: z.number().int(),
  fetched: z.number().int(),
  preserved: z.number().int(),
  parsed: z.number().int(),
  ocrExtracted: z.number().int(),
  indexed: z.number().int(),
  warnings: z.number().int(),
  failures: z.number().int(),
  retries: z.number().int(),
  rateLimitWaitMs: z.number().int(),
  checkpoint: z.string().nullable(),
});

export const collectionStatusResponse = z.object({
  id: uuid,
  name: z.string(),
  status: collectionStatusValue,
  completeness: completeness.nullable(),
  completenessNarrative: z.string().nullable(),
  sources: z.array(collectionSource),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  progress: z.array(custodianProgress),
  exceptionCounts: z.record(z.string(), z.number()),
  manifest: z
    .object({ objectKey: z.string(), sha256: z.string(), downloadAvailable: z.boolean() })
    .nullable(),
});
export type CollectionStatusResponse = z.infer<typeof collectionStatusResponse>;

export const collectionAction = z.enum(['pause', 'resume', 'cancel', 'retry']);
