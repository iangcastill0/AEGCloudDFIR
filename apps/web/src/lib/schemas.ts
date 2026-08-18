/**
 * Response schemas for API endpoints that do not (yet) have DTOs in
 * @aeg-clouddfir/contracts. Where contracts schemas exist they are imported
 * and reused; everything here follows the same conventions (paginated
 * envelopes, string BigInts, ISO dates).
 */
import { z } from 'zod';

// A proper re-export, not `export { importedName }`. The latter type-checks but
// webpack rejects it with "has no internal name", failing the production build
// while tsc and the unit tests pass — so it only surfaces in `next build`.
export {
  caseMember,
  productionDetail,
  type ProductionDetail,
  caseMemberListResponse,
  caseNote,
  caseNoteListResponse,
  caseTag,
  caseTagListResponse,
  exceptionEntry,
  exceptionListResponse,
} from '@aeg-clouddfir/contracts';
import {
  chainOfCustodyEntry,
  evidenceSummary,
  exportStatusResponse,
  paginated,
  savedSearchResponse,
  tagResponse,
  caseResponse,
} from '@aeg-clouddfir/contracts';

// --- Session / tenants ---

export const meResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  roles: z.array(z.string()),
  memberships: z.array(
    z.object({ tenantId: z.string(), tenantName: z.string(), roles: z.array(z.string()) }),
  ),
});
export type MeResponse = z.infer<typeof meResponse>;

export const authTenantsResponse = z.object({
  tenants: z.array(
    z.object({
      tenantId: z.string(),
      name: z.string(),
      slug: z.string(),
      status: z.string(),
      roles: z.array(z.string()),
    }),
  ),
});

export const logoutResponse = z.object({ logoutUrl: z.string().nullable() });

export const csrfResponse = z.object({ token: z.string() });

// --- Connectors ---

export const connectorSummary = z.object({
  id: z.string(),
  provider: z.enum(['microsoft', 'google']),
  mode: z.enum(['delegated', 'organization']),
  label: z.string().default(''),
  externalIdentity: z.string().default(''),
  status: z.string().default('unknown'),
  statusDetail: z.string().default(''),
  createdAt: z.string().optional(),
});
export type ConnectorSummary = z.infer<typeof connectorSummary>;

export const connectorListResponse = paginated(connectorSummary);

export const createConnectorResponse = z.object({
  id: z.string(),
  /** Present for delegated OAuth flows; browser should navigate to it. */
  authorizationUrl: z.string().nullable().default(null),
  /** Present for Microsoft organization mode (admin-consent URL). */
  adminConsentUrl: z.string().nullable().default(null),
});

export const connectorTestResponse = z.object({
  ok: z.boolean(),
  message: z.string().default(''),
});

export const custodianEntry = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().default(''),
});
export type CustodianEntry = z.infer<typeof custodianEntry>;

export const custodianListResponse = paginated(custodianEntry);

// --- Uploads ---

/** POST /api/v1/uploads response: the preserved container's identity. */
export const uploadResponse = z.object({
  uploadId: z.string(),
  filename: z.string(),
  sha256: z.string(),
  size: z.number(),
});
export type UploadResponse = z.infer<typeof uploadResponse>;

// --- Collections ---

export const collectionSummary = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  kind: z.string().default('snapshot'),
  sources: z.array(z.string()).default([]),
  completeness: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});
export type CollectionSummary = z.infer<typeof collectionSummary>;

export const collectionListResponse = paginated(collectionSummary);

export const createdIdResponse = z.object({ id: z.string() });

// --- Search / evidence ---

export const searchHit = evidenceSummary.extend({
  kind: z.string(),
  highlights: z.array(z.string()).default([]),
  familyRole: z.enum(['none', 'parent', 'child']).default('none'),
});
export type SearchHit = z.infer<typeof searchHit>;

export const searchFacet = z.object({
  field: z.string(),
  label: z.string().default(''),
  values: z.array(z.object({ value: z.string(), count: z.number() })),
});

/**
 * Raw shape returned by POST /api/v1/search (the search package's hits are
 * passed through by the API); adapted to `searchResponse` in hooks.ts.
 */
export const rawSearchResponse = z.object({
  total: z.number().int().default(0),
  items: z
    .array(
      z.object({
        id: z.string(),
        score: z.number().nullable().optional(),
        source: z.record(z.string(), z.unknown()),
        highlights: z.record(z.string(), z.array(z.string())).optional(),
      }),
    )
    .default([]),
  searchAfter: z
    .array(z.union([z.string(), z.number()]))
    .nullable()
    .optional(),
  facets: z
    .record(z.string(), z.array(z.object({ value: z.string(), count: z.number() })))
    .optional(),
});
export type RawSearchResponse = z.infer<typeof rawSearchResponse>;

export const searchResponse = z.object({
  items: z.array(searchHit),
  nextCursor: z.string().nullable(),
  total: z.number().int().default(0),
  facets: z.array(searchFacet).default([]),
});
export type SearchResponse = z.infer<typeof searchResponse>;

export const explainResponse = z.object({
  matches: z
    .array(
      z.object({
        field: z.string(),
        fragment: z.string().default(''),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

export const evidenceDetail = evidenceSummary.extend({
  metadata: z.record(z.string(), z.unknown()).default({}),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  extractedText: z.string().nullable().default(null),
  family: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        relationship: z.string(),
      }),
    )
    .default([]),
  versions: z
    .array(
      z.object({
        id: z.string(),
        versionLabel: z.string(),
        modifiedAt: z.string().nullable().default(null),
        sha256: z.string().default(''),
      }),
    )
    .default([]),
  custody: z.array(chainOfCustodyEntry).default([]),
  productionHistory: z
    .array(
      z.object({
        productionId: z.string(),
        productionName: z.string(),
        batesStart: z.string().default(''),
        batesEnd: z.string().default(''),
        producedAt: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type EvidenceDetail = z.infer<typeof evidenceDetail>;

export const previewResponse = z.object({
  kind: z.enum(['safe_html', 'text', 'none']),
  content: z.string().default(''),
  isApiExportDerivative: z.boolean().default(false),
});

export const auditRecordEntry = z.object({
  id: z.string(),
  system: z.string(),
  providerRecordId: z.string(),
  workload: z.string(),
  operation: z.string(),
  recordType: z.string(),
  actorId: z.string(),
  actorEmail: z.string(),
  actorIp: z.string(),
  targetId: z.string(),
  targetType: z.string(),
  resultStatus: z.string(),
  occurredAt: z.string().nullable(),
  raw: z.unknown(),
});
export type AuditRecordEntry = z.infer<typeof auditRecordEntry>;

export const auditRecordsResponse = z.object({
  items: z.array(auditRecordEntry),
  nextCursor: z.string().nullable(),
  batch: z.object({ id: z.string(), name: z.string(), sha256: z.string() }),
});

// --- Tags / saved searches / cases ---

export const tagListResponse = paginated(tagResponse);
export const savedSearchListResponse = paginated(savedSearchResponse);
export const caseListResponse = paginated(caseResponse);

// --- Exports / productions ---

export const exportListResponse = paginated(exportStatusResponse);

export const productionSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  createdAt: z.string().optional(),
  latestRunStatus: z.string().nullable().default(null),
});
export const productionListResponse = paginated(productionSummary);

export const submitProductionResponse = z.object({ runId: z.string() });

// --- Audit / members ---

export const auditEvent = z.object({
  id: z.string(),
  sequence: z.string(),
  actorUserId: z.string(),
  actorDisplay: z.string(),
  effectiveRoles: z.array(z.string()),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  requestId: z.string(),
  ipAddress: z.string(),
  userAgent: z.string(),
  summary: z.unknown(),
  occurredAt: z.string(),
  prevEventHash: z.string(),
  eventHash: z.string(),
});
export const auditListResponse = paginated(auditEvent);

export const auditVerifyResponse = z.object({
  valid: z.boolean(),
  checkedCount: z.number().int(),
  firstInvalidSequence: z.string().nullable(),
  reason: z.string(),
});

export const memberEntry = z.object({
  membershipId: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: z.string(),
  roles: z.array(z.string()),
});
export const memberListResponse = paginated(memberEntry);
