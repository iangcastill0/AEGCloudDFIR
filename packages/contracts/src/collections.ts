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
   * Chat scope: which conversations to collect.
   *
   * DMs default OFF. Reaching a custodian's private messages is a materially
   * larger intrusion than reading a public channel, and it should be a decision
   * someone made rather than a default they inherited.
   */
  chat: z
    .object({
      /** Explicit conversation ids, or null for everything reachable. */
      conversationIds: z.array(z.string().min(1)).nullable().default(null),
      includePublic: z.boolean().default(true),
      includePrivate: z.boolean().default(true),
      includeDms: z.boolean().default(false),
      includeGroupDms: z.boolean().default(false),
      includeArchived: z.boolean().default(false),
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
          /**
           * Admin SDK Reports API application names. Full catalog; kept in sync
           * with GOOGLE_REPORTS_APPLICATIONS in @aeg-clouddfir/connectors (the
           * contracts package must not import from connectors). `gmail` is
           * special — it needs a bounded <=30-day window (see the collection's
           * date range) and its events are decoded from event_info.mail_event_type.
           */
          reportApplications: z
            .array(
              z.enum([
                'login',
                'admin',
                'drive',
                'token',
                'user_accounts',
                'mobile',
                'groups',
                'groups_enterprise',
                'saml',
                'calendar',
                'chat',
                'meet',
                'chrome',
                'gcp',
                'gplus',
                'rules',
                'context_aware_access',
                'access_transparency',
                'keep',
                'vault',
                'classroom',
                'data_studio',
                'gemini_in_workspace_apps',
                'jamboard',
                'meet_hardware',
                'ldap',
                'profile',
                'tasks',
                'contacts',
                'cloud_search',
                'data_migration',
                'directory_sync',
                'admin_data_action',
                'access_evaluation',
                'assignments',
                'gmail',
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
  /**
   * Case to file this collection under.
   *
   * Omit it and one is created, named after the collection. A matter usually
   * runs several collections — one per custodian, or a second pass after a
   * scope change — so naming an existing case keeps them together instead of
   * scattering the evidence across a case each.
   */
  caseId: uuid.optional(),
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
  /**
   * The case this collection is filed under, so the page can link straight to
   * the reviewable copy of what it collected. Null only for collections made
   * before cases became automatic.
   */
  case: z.object({ id: uuid, name: z.string() }).nullable().default(null),
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
  /** Items with no preserved bytes: re-fetched from the provider. */
  retriedItems: z.number().int().optional(),
  /** Items collected but unreadable by a later stage: re-extracted. */
  retriedProcessing: z.number().int().optional(),
  /**
   * Items whose bytes are already preserved and hashed, and which only failed
   * to reach the search index. Re-indexed, NOT re-downloaded — reported apart
   * so an operator can see that nothing was fetched from the provider again.
   */
  retriedIndexing: z.number().int().optional(),
  /**
   * Custodian/source enumerations that never produced collection items.
   * Re-queued as collection.discover — not as fetch-item, which has nothing
   * to fetch until folders exist.
   */
  retriedDiscovery: z.number().int().optional(),
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

/**
 * How a collection is moving, measured. NOT predicted.
 *
 * There is deliberately no field anywhere below for a finish time, a remaining
 * duration, or a low/high band around one. Replaying the biggest real run
 * (185,379 provider items that became 434,910 evidence items and 130 GB,
 * 2026-09-10 19:43 to 2026-09-14 16:56) a 5-minute measurement window predicted
 * the rest of the run between -16% and +33% of the truth, a 30-minute window
 * between -25% and +68%, and even a low/high band missed the real answer at 4 of
 * 9 checkpoints. A number that wrong, shown to someone deciding whether to wait,
 * is worse than no number. Elapsed time, measured pace, counts and size only.
 *
 * Two phases, reported apart. Acquisition (bytes arriving from the provider)
 * took 66.00 h of that run; the run took 93.22 h. So 27.22 h — 29% — happened
 * after the last byte arrived, in parse/extract/OCR/index. A single bar cannot
 * show that, and today's UI does not show it at all.
 */
export const collectionThroughputState = z.enum([
  /** Too little measured yet to state a pace. Show counts, no rate. */
  'measuring',
  /** The denominator is still moving, so no percentage can be honest. */
  'discovering',
  /** Acquiring from the provider at a normal pace for this run. */
  'fetching',
  /** Acquisition is done; the processing tail is still running. */
  'processing',
  /** Still moving, but below this run's own 10th-percentile minute. */
  'slow',
  /** Provider throttling rose since the previous poll. */
  'rate_limited',
  /** Nothing acquired for 15 minutes while work is still in flight. */
  'stalled',
  /** Terminal: completed, failed or cancelled. */
  'finished',
]);
export type CollectionThroughputState = z.infer<typeof collectionThroughputState>;

/**
 * Whether anything is wrong, decided by the SERVER.
 *
 * The browser must never re-derive this from the counts. Two places computing
 * "is this healthy" drift apart, and then the page and the ledger disagree in
 * front of a user. `healthy` is impossible whenever exceptions exist, however
 * the collection ended.
 */
export const collectionThroughputHealth = z.enum(['healthy', 'attention', 'problem']);

/** One measurement bucket. `bytes` is a number: JSON has no BigInt. */
export const collectionThroughputBucket = z.object({
  /** Bucket start, ISO 8601 UTC. */
  startedAt: z.string(),
  /** Whole minutes from the first acquired item, so x starts at 0. */
  minutesFromStart: z.number().int(),
  items: z.number().int(),
  bytes: z.number().int(),
  /**
   * Bytes preserved up to and including this bucket. Drawn, never extended
   * forward: 249,531 of that run's 434,910 items were attachments that `parse`
   * created after their parent, so the final total is unknowable mid-run.
   */
  cumulativeBytes: z.number().int(),
  /** Acquired nothing. Only 12 minutes of 3,948 were idle, and no gap ran over 5. */
  idle: z.boolean(),
});
export type CollectionThroughputBucket = z.infer<typeof collectionThroughputBucket>;

/**
 * Measured pace, with this run's own spread.
 *
 * Both curves are drawn because neither predicts the other: across 3,948
 * buckets of the real run items/sec and bytes/sec correlated at -0.143, which is
 * nothing. Item size p50 was 21 kB, p99 3,188 kB and the largest single item
 * 672 MB, so a fast minute by count can be a slow minute by bytes.
 *
 * Every field is nullable, and null means "not measured yet" — never 0. A zero
 * pace on screen reads as stalled, and saying "stalled" about a collection that
 * has simply not been running a full minute is a false alarm.
 */
export const collectionThroughputPace = z.object({
  itemsPerMinute: z.number().nullable(),
  bytesPerMinute: z.number().nullable(),
  /** p10/p50/p90 of this run's own minutes — the band behind the sparkline. */
  p10ItemsPerMinute: z.number().nullable(),
  p50ItemsPerMinute: z.number().nullable(),
  p90ItemsPerMinute: z.number().nullable(),
  peakItemsPerMinute: z.number().nullable(),
});
export type CollectionThroughputPace = z.infer<typeof collectionThroughputPace>;

/** One of the two phases, with its own progress, its own clock, its own pace. */
export const collectionPhaseProgress = z.object({
  phase: z.enum(['acquisition', 'processing']),
  /** Items settled in this phase. */
  done: z.number().int(),
  /**
   * null while the denominator is still moving. A page walk that has not
   * finished, or a parse that will still create attachment children, means any
   * total is provisional — and a percentage of a provisional total is a lie.
   */
  total: z.number().int().nullable(),
  percent: z.number().nullable(),
  /** Still working inside this phase. */
  inFlight: z.number().int(),
  /** Wall clock spent in this phase so far, milliseconds. */
  elapsedMs: z.number().int(),
  pace: collectionThroughputPace,
});
export type CollectionPhaseProgress = z.infer<typeof collectionPhaseProgress>;

/**
 * `collection_items` state counts, the input to the stacked phase bar. Grouped
 * in the database rather than counted in the browser: this breakdown measured
 * 31.9 ms on the 434,910-item collection as an index-only scan.
 */
export const collectionItemStateCounts = z.object({
  discovered: z.number().int(),
  fetching: z.number().int(),
  preserved: z.number().int(),
  processed: z.number().int(),
  indexed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type CollectionItemStateCounts = z.infer<typeof collectionItemStateCounts>;

export const collectionThroughputResponse = z.object({
  collectionId: uuid,
  status: collectionStatusValue,
  /**
   * Which window was measured, and its plain name for the heading. Named rather
   * than inferred from the bucket count so the page can never mislabel itself.
   */
  window: z.enum(['live', 'history']),
  windowName: z.string(),
  /** Minutes per bucket. 1 for the live window; wider for a downsampled run. */
  bucketMinutes: z.number().int(),
  /**
   * Oldest first, gaps filled with idle buckets. The history window is
   * downsampled server-side to about 200 buckets: the real run had 3,948
   * minutes, and a browser draws them on roughly 900 pixels.
   */
  buckets: z.array(collectionThroughputBucket),
  totals: z.object({
    items: z.number().int(),
    bytes: z.number().int(),
    /** First and last acquisition, so elapsed time is checkable, not asserted. */
    firstAcquiredAt: z.string().nullable(),
    lastAcquiredAt: z.string().nullable(),
    /** Acquisition wall clock. 66.00 h of the real run's 93.22 h. */
    acquisitionElapsedMs: z.number().int(),
    /** Whole-run wall clock, so the tail is the difference of the two. */
    runElapsedMs: z.number().int(),
    idleBuckets: z.number().int(),
  }),
  acquisition: collectionPhaseProgress,
  processing: collectionPhaseProgress,
  itemStates: collectionItemStateCounts,
  /** Decided by the server. See collectionThroughputState. */
  state: collectionThroughputState,
  /** The word shown beside the icon, because colour is never the only signal. */
  stateLabel: z.string(),
  health: collectionThroughputHealth,
  /**
   * Total provider throttling so far. Across the whole 66 h acquisition this was
   * 8.45 minutes, so a rise in it really does mean the provider pushed back.
   */
  rateLimitWaitMs: z.number().int(),
  /** Outstanding exceptions. Any non-zero count forbids `healthy`. */
  exceptionCount: z.number().int(),
});
export type CollectionThroughputResponse = z.infer<typeof collectionThroughputResponse>;
