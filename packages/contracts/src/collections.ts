import { z } from 'zod';
import { collectionSource, completeness, idempotencyKey, paginated, uuid } from './common.js';

/**
 * Canonical IANA timezone id. Uses Intl.supportedValuesOf so legacy
 * abbreviations like "PST" (ambiguous across jurisdictions) are rejected;
 * an explicit Area/Location id or UTC is required.
 */
const CANONICAL_TIMEZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
]);

export const timezoneId = z.string().refine((tz) => CANONICAL_TIMEZONES.has(tz), {
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
  /**
   * Audit-log scope. Audit logs are tenant/org-wide, not per-custodian; an
   * optional actor filter narrows to specific principals when the provider
   * supports it. A date range is strongly recommended (providers cap history
   * retention — Purview Audit Standard ~180 days, Google Reports ~180 days).
   */
  audit: z
    .object({
      microsoft: z
        .object({
          /** Office 365 Management Activity API content types. */
          managementContentTypes: z
            .array(
              z.enum([
                'Audit.Exchange',
                'Audit.SharePoint',
                'Audit.AzureActiveDirectory',
                'Audit.General',
                'DLP.All',
              ]),
            )
            .default([]),
          includeGraphSignins: z.boolean().default(false),
          includeGraphDirectoryAudits: z.boolean().default(false),
        })
        .optional(),
      google: z
        .object({
          /** Admin SDK Reports API application names. */
          reportApplications: z
            .array(
              z.enum([
                'login',
                'drive',
                'admin',
                'token',
                'mobile',
                'user_accounts',
                'groups',
                'saml',
              ]),
            )
            .default([]),
          includeVault: z.boolean().default(false),
          /** Specific Vault matter ids to enumerate exports from (empty = all accessible). */
          vaultMatterIds: z.array(z.string()).default([]),
        })
        .optional(),
      dropbox: z
        .object({
          /**
           * Collect the Dropbox Business team event log.
           *
           * Team only. A personal Dropbox has no event log any app can read —
           * the call is refused with USER_AUTH_NOT_ALLOWED — so this requires an
           * organization-mode connector holding a team grant.
           */
          includeTeamLog: z.boolean().default(false),
        })
        .optional(),
      /** Restrict to specific actor principals (UPN/email) when supported. */
      actorFilter: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * Uploaded-container scope: previously uploaded evidence items (kind
   * 'container', provider 'upload') to extract messages from. Present ONLY on
   * upload collections; the containers stay the authoritative originals and
   * extracted messages are labeled reconstructions (see
   * TRUTHFULNESS_NOTICES.pstExtraction).
   */
  uploads: z
    .object({
      evidenceItemIds: z.array(uuid).min(1),
    })
    .optional(),
});
export type CollectionScope = z.infer<typeof collectionScope>;

/**
 * Custodian attribution for an upload collection: uploaded files have no
 * provider directory, so the custodian is declared at collection time (or an
 * existing upload custodian is selected via custodianIds instead).
 */
export const uploadCustodian = z.object({
  email: z.string().email(),
  displayName: z.string().max(200).default(''),
});

/**
 * Field shape of the create-collection request WITHOUT cross-field rules.
 * The API layer extends this object (e.g. custodianIds cap) and re-applies
 * its own cross-field rules; other consumers should use
 * `createCollectionRequest`, which enforces the rules below.
 */
export const createCollectionRequestFields = z.object({
  idempotencyKey,
  /** Required for provider collections; resolved server-side for uploads. */
  connectorAccountId: uuid.optional(),
  name: z.string().min(1).max(200),
  kind: z.enum(['snapshot', 'continuous']).default('snapshot'),
  sources: z.array(collectionSource).min(1),
  custodianIds: z.array(uuid),
  uploadCustodian: uploadCustodian.optional(),
  scope: collectionScope,
});

export const createCollectionRequest = createCollectionRequestFields.superRefine((value, ctx) => {
  const isUpload = value.scope.uploads !== undefined;
  if (isUpload) {
    if (value.sources.length !== 1 || value.sources[0] !== 'email') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'upload collections support only the email source',
      });
    }
    const hasCustodianIds = value.custodianIds.length > 0;
    const hasUploadCustodian = value.uploadCustodian !== undefined;
    if (hasCustodianIds === hasUploadCustodian) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custodianIds'],
        message: 'upload collections require exactly one of custodianIds or uploadCustodian',
      });
    }
  } else {
    if (value.connectorAccountId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectorAccountId'],
        message: 'connectorAccountId is required for provider collections',
      });
    }
    if (value.custodianIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custodianIds'],
        message: 'at least one custodian is required',
      });
    }
    if (value.uploadCustodian !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uploadCustodian'],
        message: 'uploadCustodian applies only to upload collections (scope.uploads)',
      });
    }
  }
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

/**
 * What an action did, not merely that it was accepted. `retry` reports both
 * kinds of retryable failure separately: items whose fetch failed, and items
 * that were collected but could not be processed. Reporting only "requested"
 * left a user unable to tell a successful retry from one that matched nothing.
 */
export const collectionActionResponse = z.object({
  id: uuid,
  status: z.string(),
  retriedItems: z.number().int().optional(),
  retriedProcessing: z.number().int().optional(),
});

/**
 * GET /collections/:id/manifest returns presigned URLs, not a file — the same
 * envelope shape exports uses. The manifest is the collection's custody
 * artifact; its SHA-256 is returned so a recipient can verify what they fetched.
 */
export const collectionManifestDownloadResponse = z.object({
  manifestUrl: z.string(),
  manifestSha256: z.string(),
  /** Human-readable completeness report, when the finalizer produced one. */
  completenessReportUrl: z.string().nullable(),
  expiresInSeconds: z.number().int(),
});

/**
 * One entry in an exceptions ledger.
 *
 * Shared by collections and productions: the client renders both through the
 * same table, so both endpoints must return this shape. It lives here rather
 * than in the web app because a response schema the API cannot import is a
 * contract nothing enforces — every field below was, at some point, returned
 * under a different name by a server that compiled cleanly.
 */
export const exceptionEntry = z.object({
  id: z.string(),
  kind: z.string(),
  message: z.string(),
  itemRef: z.string().nullable().default(null),
  /** Recorded so the ledger can name the item; absent on pre-existing rows. */
  evidenceItemId: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  sizeBytes: z.number().nullable().default(null),
  /** Production exceptions carry these; collection exceptions do not. */
  severity: z.string().nullable().default(null),
  overridden: z.boolean().default(false),
  occurredAt: z.string().optional(),
});
export const exceptionListResponse = paginated(exceptionEntry);

/** A case member, with the identity behind the membership id. */
export const caseMember = z.object({
  membershipId: z.string(),
  email: z.string(),
  displayName: z.string().default(''),
  roles: z.array(z.string()).default([]),
});
export const caseMemberListResponse = paginated(caseMember);

/** A case note. authorDisplay, not an id: a UUID tells a reader nothing. */
export const caseNote = z.object({
  id: z.string(),
  authorDisplay: z.string().default(''),
  text: z.string(),
  createdAt: z.string(),
});
export const caseNoteListResponse = paginated(caseNote);

/** A tag as it appears within a case, with how many of the case's items carry it. */
export const caseTag = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().default(''),
  itemCount: z.number().int(),
});
export const caseTagListResponse = z.object({ items: z.array(caseTag) });

/**
 * What a case actually contains, aggregated in the database rather than by
 * counting rows in the browser: a case can hold tens of thousands of items.
 */
export const caseSummary = z.object({
  itemCount: z.number().int(),
  /** email / file / container / audit_batch … */
  byKind: z.array(z.object({ kind: z.string(), count: z.number().int() })),
  /** How each item entered: collection, tag, search, manual, family. */
  bySource: z.array(z.object({ addedVia: z.string(), count: z.number().int() })),
  /** Which acquisitions the case draws on, named rather than by id. */
  collections: z.array(z.object({ id: z.string(), name: z.string(), count: z.number().int() })),
  custodians: z.array(z.object({ id: z.string(), email: z.string(), count: z.number().int() })),
  /** Span of the evidence itself, not of when it was added. */
  earliestItemDate: z.string().nullable(),
  latestItemDate: z.string().nullable(),
  noteCount: z.number().int(),
  memberCount: z.number().int(),
});
export type CaseSummary = z.infer<typeof caseSummary>;

/**
 * One entry in a case's history, drawn from the audit chain.
 *
 * Separate from /audit, which needs org_admin or auditor: someone working a case
 * should be able to see that case's own history without being able to read every
 * event in the tenant.
 */
export const caseActivityEntry = z.object({
  id: z.string(),
  /** BigInt in the database; a string here, like every other sequence. */
  sequence: z.string(),
  action: z.string(),
  actorDisplay: z.string().default(''),
  occurredAt: z.string(),
  /** Plain-language description built from the event's own summary. */
  detail: z.string().default(''),
});
export const caseActivityListResponse = paginated(caseActivityEntry);

/** What adding items to a case actually did. */
export const addCaseItemsResponse = z.object({
  requested: z.number().int(),
  added: z.number().int(),
});
