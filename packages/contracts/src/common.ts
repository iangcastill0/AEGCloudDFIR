import { z } from 'zod';

export const uuid = z.string().uuid();

export const cursorPaginationQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const idempotencyKey = z.string().min(8).max(128);

/** The only permitted completeness vocabulary — never an unqualified "complete". */
export const completeness = z.enum([
  'complete_within_selected_api_scope',
  'complete_with_exceptions',
  'partial',
  'failed',
  'cancelled',
]);
export type Completeness = z.infer<typeof completeness>;

export const provider = z.enum(['microsoft', 'google']);
export const connectionMode = z.enum(['delegated', 'organization']);
export const collectionSource = z.enum(['email', 'drive', 'audit']);

/** Upstream audit systems EvidenceVault can collect from. */
export const auditSystem = z.enum([
  'o365_management_activity',
  'graph_directory_audits',
  'graph_signins',
  'google_reports',
  'google_vault',
]);
export type AuditSystem = z.infer<typeof auditSystem>;

export const tenantRole = z.enum([
  'org_admin',
  'case_manager',
  'reviewer',
  'read_only',
  'production_manager',
  'auditor',
]);
export type TenantRole = z.infer<typeof tenantRole>;

export const apiError = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

/**
 * Standing truthfulness copy required contextually across collection and
 * export/production screens (contract §20). Centralized so UI and reports
 * stay consistent.
 */
export const TRUTHFULNESS_NOTICES = {
  allTimeScope:
    '“All time” means all items returned within the selected account, its permissions, the API-visible scope, current retention state, and provider limitations. Items purged or altered before acquisition cannot be collected.',
  delegatedAccess:
    'A personally connected account collects only data that signed-in identity can access. Delegated access does not make other users’ accounts selectable.',
  bcc: 'BCC recipients are searchable only when a BCC header or API field was actually present in the acquired message data. Absence of other recipients is never treated as BCC.',
  googleNativeExports:
    'Google-native documents (Docs, Sheets, Slides, Drawings) are preserved as API exports in the configured formats. They are preservation derivatives, not byte-identical natives, and are labeled as such.',
  exceptions:
    'Encrypted, rights-managed, corrupt, unavailable, deleted-before-acquisition, or unsupported content can produce exceptions. Exceptions are listed in the collection’s exception ledger and manifests.',
  defensibility:
    'Hashes, manifests, and chain-of-custody records support defensibility but do not by themselves guarantee legal admissibility or regulatory compliance. Consult qualified counsel.',
  auditScope:
    'Audit logs are constrained by the provider’s retention window (e.g. Purview Audit Standard ~180 days, Google Workspace reports ~180 days) and the enabled audit configuration at the time events occurred. Events outside the retained window, or not captured because auditing was disabled, cannot be collected and are reported as scope limitations.',
} as const;
