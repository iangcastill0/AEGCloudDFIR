'use client';
/** React Query hooks for the AEG-CloudDFIR API. */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import {
  addCaseItemsResponse,
  type CreateConnectorRequest,
  caseActivityListResponse,
  caseSummary,
  caseTagListResponse,
  collectionStatusResponse,
  validateProductionResponse,
  createExportResponse,
  collectionActionResponse,
  collectionManifestDownloadResponse,
  exportDownloadResponse,
  productionRunDownloadResponse,
  tagResponse,
  savedSearchResponse,
  caseResponse,
} from '@aeg-clouddfir/contracts';
import { z } from 'zod';
import { apiFetch, apiUpload } from './api';
import type { WebCreateCollectionRequest } from './collection-wizard';
import {
  auditListResponse,
  auditRecordsResponse,
  auditVerifyResponse,
  authTenantsResponse,
  caseListResponse,
  caseMemberListResponse,
  caseNoteListResponse,
  collectionListResponse,
  connectorListResponse,
  connectorTestResponse,
  createConnectorResponse,
  createdIdResponse,
  custodianListResponse,
  evidenceDetail,
  exceptionListResponse,
  exportListResponse,
  logoutResponse,
  meResponse,
  memberListResponse,
  orgSetupResponse,
  previewResponse,
  productionDetail,
  productionListResponse,
  rawSearchResponse,
  type RawSearchResponse,
  type SearchResponse,
  submitProductionResponse,
  tagListResponse,
  savedSearchListResponse,
  searchFieldListResponse,
  uploadResponse,
} from './schemas';

// --- Session ---

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch('/api/v1/me', { schema: meResponse }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useAuthTenants() {
  return useQuery({
    queryKey: ['auth-tenants'],
    queryFn: () => apiFetch('/auth/tenants', { schema: authTenantsResponse }),
  });
}

export function useSelectTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch('/auth/select-tenant', { method: 'POST', body: { tenantId } }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => apiFetch('/auth/logout', { method: 'POST', schema: logoutResponse }),
  });
}

// --- Connectors ---

export function useConnectors() {
  return useQuery({
    queryKey: ['connectors'],
    queryFn: () => apiFetch('/api/v1/connectors?limit=100', { schema: connectorListResponse }),
  });
}

/**
 * The create body is now the contract's own type. The old shape carried an
 * `organization` object that the API never read — organization credentials go
 * to POST /connectors/:id/org, a separate step, via useSetupOrgConnector below.
 */
export type CreateConnectorInput = CreateConnectorRequest;

/** POST /connectors/:id/org — the second step for organization mode. */
export function useSetupOrgConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      apiFetch(`/api/v1/connectors/${id}/org`, {
        method: 'POST',
        body,
        schema: orgSetupResponse,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
  });
}

export function useCreateConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConnectorInput) =>
      apiFetch('/api/v1/connectors', {
        method: 'POST',
        body: input,
        schema: createConnectorResponse,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
  });
}

export function useTestConnector() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/connectors/${id}/test`, { method: 'POST', schema: connectorTestResponse }),
  });
}

export function useRevokeConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/connectors/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
  });
}

/**
 * Live-directory custodian lookup, cursor-paginated. Organization-mode
 * connectors return directory matches for `search`; delegated connectors
 * return exactly the connected identity.
 */
export function useCustodians(connectorId: string, search: string) {
  return useInfiniteQuery({
    queryKey: ['custodians', connectorId, search],
    queryFn: ({ pageParam }) =>
      apiFetch(
        `/api/v1/connectors/${connectorId}/custodians?limit=50${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { schema: custodianListResponse },
      ),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: connectorId.length > 0,
    placeholderData: keepPreviousData,
  });
}

// --- Uploads ---

export interface UploadFileInput {
  file: File;
  onProgress?: (fraction: number) => void;
}

/** Upload one PST/OST container; call sequentially for multiple files. */
export function useUpload() {
  return useMutation({
    mutationFn: ({ file, onProgress }: UploadFileInput) =>
      apiUpload('/api/v1/uploads', file, { schema: uploadResponse, onProgress }),
  });
}

// --- Collections ---

const ACTIVE_COLLECTION_STATUSES = new Set([
  'created',
  'discovering',
  'fetching',
  'processing',
  'finalizing',
  'cancelling',
]);

export function isCollectionActive(status: string | undefined): boolean {
  return status !== undefined && ACTIVE_COLLECTION_STATUSES.has(status);
}

export function useCollections() {
  return useQuery({
    queryKey: ['collections'],
    queryFn: () => apiFetch('/api/v1/collections?limit=100', { schema: collectionListResponse }),
  });
}

/** Polls every 2 s while the collection is in an active status. */
export function useCollectionStatus(id: string) {
  return useQuery({
    queryKey: ['collection', id],
    queryFn: () => apiFetch(`/api/v1/collections/${id}`, { schema: collectionStatusResponse }),
    refetchInterval: (query) => (isCollectionActive(query.state.data?.status) ? 2000 : false),
  });
}

export function useCreateCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WebCreateCollectionRequest) =>
      apiFetch('/api/v1/collections', { method: 'POST', body, schema: createdIdResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  });
}

export function useCollectionAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel' | 'retry') =>
      apiFetch(`/api/v1/collections/${id}/${action}`, {
        method: 'POST',
        schema: collectionActionResponse,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['collection', id] });
      // A retry clears ledger rows, so the exceptions list is stale too.
      // Without this the entry stays on screen and the retry looks ineffective.
      void qc.invalidateQueries({ queryKey: ['collection-exceptions', id] });
    },
  });
}

export function useCollectionExceptions(id: string, kindFilter: string) {
  return useQuery({
    queryKey: ['collection-exceptions', id, kindFilter],
    queryFn: () =>
      apiFetch(
        `/api/v1/collections/${id}/exceptions?limit=100${kindFilter ? `&kind=${encodeURIComponent(kindFilter)}` : ''}`,
        { schema: exceptionListResponse },
      ),
  });
}

// --- Search / evidence ---

export interface SearchRequestInput {
  queryText: string;
  /** Structured query from the visual builder; takes precedence over queryText. */
  builder?: unknown;
  /** Which language queryText is written in; composed clauses must match it. */
  syntax?: 'simple' | 'advanced';
  caseId?: string;
  custodianEmail?: string;
  source?: string;
  facetFilters?: Record<string, string[]>;
  cursor?: string | null;
  limit?: number;
}

/** Facet fields we both aggregate on and can express as query-language filters. */
const FACET_QUERY_FIELDS: Record<string, string> = {
  custodianEmail: 'custodian',
  extension: 'ext',
  provider: 'provider',
  tagNames: 'tag',
};

/**
 * Compose the API's single query string from the rail's filters.
 *
 * The clauses must be written in the SAME language as the user's text, or the
 * parser sees a mix and rejects the whole query. `kind`, not `type`: `type` is
 * not a field, and emitting it made choosing a Source fail every search with
 * "Unknown field \"type\"".
 */
export function composeQuery(input: SearchRequestInput): string {
  const advanced = input.syntax === 'advanced';
  const eq = (field: string, value: string): string =>
    advanced ? `${field} IS "${value}"` : `${field}:"${value}"`;

  const parts: string[] = [];
  const text = input.queryText.trim();
  if (text.length > 0) parts.push(`(${text})`);
  if (input.custodianEmail) parts.push(eq('custodian', input.custodianEmail.trim()));
  if (input.source === 'email') {
    parts.push(`(${eq('kind', 'email')} OR ${eq('kind', 'attachment')})`);
  }
  if (input.source === 'drive') parts.push(eq('kind', 'file'));
  for (const [field, values] of Object.entries(input.facetFilters ?? {})) {
    const queryField = FACET_QUERY_FIELDS[field];
    if (!queryField || values.length === 0) continue;
    const clause = values.map((v) => eq(queryField, v.replaceAll('"', ''))).join(' OR ');
    parts.push(values.length > 1 ? `(${clause})` : clause);
  }
  return parts.join(' AND ');
}

/**
 * The same rail filters as `composeQuery`, but as builder JSON.
 *
 * A built query is sent as structured JSON, so the text clauses composeQuery
 * produces would never be seen. Without this, ticking a facet in build mode
 * changed nothing at all and the results looked unfiltered — the filter was
 * dropped in silence.
 */
export function composeBuilder(input: SearchRequestInput, builder: unknown): unknown {
  const eq = (field: string, value: string) => ({ field, operator: 'equals', value });
  const extra: unknown[] = [];

  if (input.custodianEmail) extra.push(eq('custodian', input.custodianEmail.trim()));
  if (input.source === 'email') {
    extra.push({ op: 'or', children: [eq('kind', 'email'), eq('kind', 'attachment')] });
  }
  if (input.source === 'drive') extra.push(eq('kind', 'file'));
  for (const [field, values] of Object.entries(input.facetFilters ?? {})) {
    const queryField = FACET_QUERY_FIELDS[field];
    if (!queryField || values.length === 0) continue;
    const children = values.map((v) => eq(queryField, v));
    extra.push(children.length === 1 ? children[0] : { op: 'or', children });
  }

  if (extra.length === 0) return builder;
  return { op: 'and', children: [builder, ...extra] };
}

function docString(doc: Record<string, unknown>, key: string): string {
  const v = doc[key];
  return typeof v === 'string' ? v : '';
}

/** Adapt the API's raw hits (search-package shape) to what the UI renders. */
export function adaptSearchResponse(raw: RawSearchResponse): SearchResponse {
  return {
    total: raw.total,
    nextCursor:
      raw.searchAfter && raw.searchAfter.length > 0 ? JSON.stringify(raw.searchAfter) : null,
    facets: Object.entries(raw.facets ?? {}).map(([field, values]) => ({
      field,
      label: field,
      values,
    })),
    items: raw.items.map(({ id, source, highlights }) => {
      const doc = source;
      const dates = (doc['dates'] ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(doc['tags']) ? (doc['tags'] as Record<string, unknown>[]) : [];
      return {
        id,
        kind: docString(doc, 'kind') || 'file',
        name: docString(doc, 'name'),
        extension: docString(doc, 'extension'),
        mimeType: docString(doc, 'mimeType'),
        size: String(typeof doc['size'] === 'number' ? doc['size'] : 0),
        sha256: docString(doc, 'sha256'),
        custodianEmail: docString(doc, 'custodianEmail') || null,
        sourcePath: docString(doc, 'sourcePath'),
        primaryDate: typeof dates['primary'] === 'string' ? (dates['primary'] as string) : null,
        processingStatus: docString(doc, 'processingStatus') || 'pending',
        malwareStatus: docString(doc, 'malwareStatus') || 'not_scanned',
        isApiExportDerivative: doc['isApiExportDerivative'] === true,
        tags: tags.map((t) => ({
          id: typeof t['id'] === 'string' ? t['id'] : '',
          name: typeof t['name'] === 'string' ? t['name'] : '',
          color: typeof t['color'] === 'string' ? (t['color'] as string) : '#6b7280',
        })),
        highlights: Object.values(highlights ?? {}).flat(),
        familyRole: (doc['isFamilyChild'] === true
          ? 'child'
          : typeof doc['familyId'] === 'string' && doc['familyId'] !== ''
            ? 'parent'
            : 'none') as 'none' | 'parent' | 'child',
      };
    }),
  };
}

/** Parameters the query builder can offer, from the API's field registry. */
export function useSearchFields() {
  return useQuery({
    queryKey: ['search-fields'],
    queryFn: () => apiFetch('/api/v1/search/fields', { schema: searchFieldListResponse }),
    // The registry only changes when the app is deployed.
    staleTime: 60 * 60 * 1000,
  });
}

export function useSearch(input: SearchRequestInput, enabled: boolean) {
  return useQuery({
    queryKey: ['search', input],
    queryFn: async () => {
      const raw = await apiFetch('/api/v1/search', {
        method: 'POST',
        body: {
          // A built query is sent as structured JSON; a typed one as text. The
          // API validates both into the same AST.
          ...(input.builder === undefined
            ? { query: composeQuery(input), syntax: input.syntax ?? 'simple' }
            : { builder: composeBuilder(input, input.builder) }),
          ...(input.caseId ? { caseId: input.caseId } : {}),
          ...(input.cursor ? { searchAfter: JSON.parse(input.cursor) as unknown[] } : {}),
          limit: input.limit ?? 100,
          facets: Object.keys(FACET_QUERY_FIELDS),
          includeHighlights: true,
        },
        schema: rawSearchResponse,
      });
      return adaptSearchResponse(raw);
    },
    enabled,
    placeholderData: keepPreviousData,
  });
}

const rawExplainResponse = z.object({
  fields: z.array(z.string()).default([]),
  clauseCount: z.number().int().default(0),
  highlightTerms: z.array(z.string()).default([]),
});

export function useExplain(queryText: string, evidenceItemId: string | null) {
  return useQuery({
    queryKey: ['explain', queryText, evidenceItemId],
    queryFn: async () => {
      const raw = await apiFetch('/api/v1/search/explain', {
        method: 'POST',
        body: { query: queryText },
        schema: rawExplainResponse,
      });
      return {
        matches: raw.fields.map((field) => ({
          field,
          fragment: '',
          reason: `matched via ${field}${raw.highlightTerms.length > 0 ? ` — terms: ${raw.highlightTerms.join(', ')}` : ''} (${raw.clauseCount} clause${raw.clauseCount === 1 ? '' : 's'})`,
        })),
      };
    },
    enabled: evidenceItemId !== null && queryText.length > 0,
  });
}

const rawChainResponse = z.object({
  acquisition: z
    .object({
      acquiredAt: z.string(),
      collectionId: z.string().nullable().default(null),
      provider: z.string().nullable().default(null),
      providerItemId: z.string().default(''),
      sourcePath: z.string().default(''),
      sha256: z.string().default(''),
      blobSha256: z.string().default(''),
      isApiExportDerivative: z.boolean().default(false),
    })
    .nullable()
    .optional(),
  events: z
    .array(
      z.object({
        sequence: z.string(),
        action: z.string(),
        actorDisplay: z.string().default(''),
        occurredAt: z.string(),
        summary: z.record(z.string(), z.unknown()).default({}),
        eventHash: z.string().default(''),
      }),
    )
    .default([]),
});

const rawHeadersResponse = z.object({
  items: z.array(z.object({ name: z.string(), value: z.string().default('') })).default([]),
});

const rawFamilyResponse = z.object({
  items: z
    .array(
      z.object({
        relationship: z.string(),
        direction: z.enum(['parent', 'child']),
        detail: z.string().default(''),
        item: z.object({
          id: z.string(),
          kind: z.string(),
          name: z.string(),
          size: z.string().default('0'),
          sha256: z.string().default(''),
        }),
      }),
    )
    .default([]),
});

export function useEvidence(id: string | null) {
  return useQuery({
    queryKey: ['evidence', id],
    queryFn: async () => {
      // The custody chain, the raw headers and the family each live on their
      // own endpoint; merge them into the detail object the panel renders. The
      // headers and family calls were missing, which is why those two tabs were
      // always empty — the schema defaulted them to [] and nothing filled them.
      const [detail, chain, headers, family] = await Promise.all([
        apiFetch(`/api/v1/evidence/${id}`, { schema: evidenceDetail }),
        apiFetch(`/api/v1/evidence/${id}/chain`, { schema: rawChainResponse }).catch(() => null),
        apiFetch(`/api/v1/evidence/${id}/headers`, { schema: rawHeadersResponse }).catch(
          () => null,
        ),
        apiFetch(`/api/v1/evidence/${id}/family`, { schema: rawFamilyResponse }).catch(() => null),
      ]);
      const extras = {
        ...(headers === null ? {} : { headers: headers.items }),
        ...(family === null
          ? {}
          : {
              family: family.items.map((rel) => ({
                id: rel.item.id,
                name: rel.item.name,
                kind: rel.item.kind,
                relationship: rel.relationship,
                direction: rel.direction,
              })),
            }),
      };
      if (chain === null) return { ...detail, ...extras };
      const acquisitionEntry = chain.acquisition
        ? [
            {
              sequence: '—',
              action: 'evidence.preserved',
              actorDisplay: `${chain.acquisition.provider ?? 'provider'} collection`,
              occurredAt: chain.acquisition.acquiredAt,
              summary: {
                sha256: chain.acquisition.sha256,
                sourcePath: chain.acquisition.sourcePath,
                providerItemId: chain.acquisition.providerItemId,
                collectionId: chain.acquisition.collectionId,
                ...(chain.acquisition.isApiExportDerivative ? { apiExportDerivative: true } : {}),
              },
              eventHash: '',
            },
          ]
        : [];
      return { ...detail, ...extras, custody: [...acquisitionEntry, ...chain.events] };
    },
    enabled: id !== null,
  });
}

const rawPreviewResponse = z.object({
  items: z
    .array(z.object({ kind: z.string(), mimeType: z.string().default(''), url: z.string() }))
    .default([]),
  note: z.string().default(''),
});

export function useEvidencePreview(id: string | null) {
  return useQuery({
    queryKey: ['evidence-preview', id],
    queryFn: async () => {
      // The API returns short-lived presigned URLs to the stored preview
      // derivatives; fetch the best one (safe HTML, else text) for inline
      // sandboxed rendering. Previews never load remote resources.
      const raw = await apiFetch(`/api/v1/evidence/${id}/preview`, { schema: rawPreviewResponse });
      const pick =
        raw.items.find((p) => p.kind === 'safe_html') ??
        raw.items.find((p) => p.kind === 'text' || p.kind === 'preview-text');
      if (!pick) return previewResponse.parse({ kind: 'none', content: raw.note });
      const res = await fetch(pick.url);
      if (!res.ok) return previewResponse.parse({ kind: 'none', content: raw.note });
      const content = await res.text();
      return previewResponse.parse({
        kind: pick.kind === 'safe_html' ? 'safe_html' : 'text',
        content,
      });
    },
    enabled: id !== null,
  });
}

export function useAuditRecords(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['evidence-audit-records', id],
    queryFn: () =>
      apiFetch(`/api/v1/evidence/${id}/audit-records?limit=100`, { schema: auditRecordsResponse }),
    enabled: id !== null && enabled,
  });
}

// --- Tags / saved searches ---

export function useTags() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: () => apiFetch('/api/v1/tags?limit=100', { schema: tagListResponse }),
  });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/v1/tags', { method: 'POST', body, schema: tagResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  });
}

export function useBulkTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      tagId: string;
      evidenceItemIds: string[];
      action: 'apply' | 'remove';
      note?: string;
    }) => apiFetch('/api/v1/tags/bulk', { method: 'POST', body }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['search'] });
      for (const id of variables.evidenceItemIds) {
        void qc.invalidateQueries({ queryKey: ['evidence', id] });
      }
    },
  });
}

export function useSavedSearches() {
  return useQuery({
    queryKey: ['saved-searches'],
    queryFn: () =>
      apiFetch('/api/v1/saved-searches?limit=100', { schema: savedSearchListResponse }),
  });
}

export function useSaveSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      caseId?: string;
      queryText: string;
      // The language matters when the search is loaded again: re-parsing an
      // advanced query with the simple parser changes what it means.
      syntax?: 'simple' | 'advanced';
      queryAst: unknown;
    }) => apiFetch('/api/v1/saved-searches', { method: 'POST', body, schema: savedSearchResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
}

// --- Cases ---

export function useCases() {
  return useQuery({
    queryKey: ['cases'],
    queryFn: () => apiFetch('/api/v1/cases?limit=100', { schema: caseListResponse }),
  });
}

export function useCase(id: string) {
  return useQuery({
    queryKey: ['case', id],
    queryFn: () => apiFetch(`/api/v1/cases/${id}`, { schema: caseResponse }),
  });
}

export function useCreateCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/v1/cases', { method: 'POST', body, schema: caseResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cases'] }),
  });
}

export function useUpdateCase(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/v1/cases/${id}`, { method: 'PUT', body, schema: caseResponse }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['case', id] });
      void qc.invalidateQueries({ queryKey: ['cases'] });
      // Placing or releasing a legal hold is audited, so the log changed.
      void qc.invalidateQueries({ queryKey: ['case-activity', id] });
    },
  });
}

export function useCaseMembers(id: string) {
  return useQuery({
    queryKey: ['case-members', id],
    queryFn: () =>
      apiFetch(`/api/v1/cases/${id}/members?limit=100`, { schema: caseMemberListResponse }),
  });
}

export function useCaseNotes(id: string) {
  return useQuery({
    queryKey: ['case-notes', id],
    queryFn: () =>
      apiFetch(`/api/v1/cases/${id}/notes?limit=100`, { schema: caseNoteListResponse }),
  });
}

export function useAddCaseNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/api/v1/cases/${id}/notes`, { method: 'POST', body: { text } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['case-notes', id] });
      // The summary counts notes, and the note is an audited event.
      void qc.invalidateQueries({ queryKey: ['case-summary', id] });
      void qc.invalidateQueries({ queryKey: ['case-activity', id] });
    },
  });
}

/** Totals for a case: what it holds and where it came from. */
export function useCaseSummary(id: string) {
  return useQuery({
    queryKey: ['case-summary', id],
    queryFn: () => apiFetch(`/api/v1/cases/${id}/summary`, { schema: caseSummary }),
  });
}

/** This case's own history, from the audit chain. */
export function useCaseActivity(id: string) {
  return useQuery({
    queryKey: ['case-activity', id],
    queryFn: () =>
      apiFetch(`/api/v1/cases/${id}/activity?limit=50`, { schema: caseActivityListResponse }),
  });
}

/**
 * Every query that goes stale when a case's contents change.
 *
 * Kept as a list rather than written out at each call site: the first version
 * refreshed the item list but not the summary or the activity log, so the two
 * panels a reviewer actually reads — "what is in this case" and its history —
 * still showed the old numbers, and the only way to see the addition was to
 * reload the page.
 */
export function caseContentQueryKeys(id: string): unknown[][] {
  return [
    ['case-items', id],
    ['case-tags', id],
    ['case', id],
    // The counts panel.
    ['case-summary', id],
    // The case's own history, which just gained a "items added" entry.
    ['case-activity', id],
    // The case list shows per-case counts too.
    ['cases'],
  ];
}

export function useAddCaseItems(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/api/v1/cases/${id}/items`, {
        method: 'POST',
        body,
        schema: addCaseItemsResponse,
      }),
    onSuccess: () => {
      for (const queryKey of caseContentQueryKeys(id)) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * Tags present on a case's items, for scoping a production to the matter.
 * Disabled until a case is chosen, so no request fires on an empty selection.
 */
export function useCaseTags(caseId: string) {
  return useQuery({
    queryKey: ['case-tags', caseId],
    enabled: caseId !== '',
    queryFn: () => apiFetch(`/api/v1/cases/${caseId}/tags`, { schema: caseTagListResponse }),
  });
}

// --- Exports ---

function anyExportActive(items: Array<{ status: string }> | undefined): boolean {
  return (items ?? []).some(
    (e) => e.status === 'queued' || e.status === 'running' || e.status === 'verifying',
  );
}

export function useExports() {
  return useQuery({
    queryKey: ['exports'],
    queryFn: () => apiFetch('/api/v1/exports?limit=100', { schema: exportListResponse }),
    refetchInterval: (query) => (anyExportActive(query.state.data?.items) ? 2000 : false),
  });
}

export function useCreateExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/v1/exports', { method: 'POST', body, schema: createExportResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exports'] }),
  });
}

/** Presigned URLs for a collection's manifest and completeness report. */
export function useCollectionManifest() {
  return useMutation({
    mutationFn: (collectionId: string) =>
      apiFetch(`/api/v1/collections/${collectionId}/manifest`, {
        schema: collectionManifestDownloadResponse,
      }),
  });
}

/** Presigned URLs for every file a production run produced. */
export function useProductionRunDownload() {
  return useMutation({
    mutationFn: ({ productionId, runId }: { productionId: string; runId: string }) =>
      apiFetch(`/api/v1/productions/${productionId}/runs/${runId}/download`, {
        schema: productionRunDownloadResponse,
      }),
  });
}

/**
 * Fetches the export's presigned URLs. The endpoint returns an envelope rather
 * than a file, so linking an <a> straight at it just renders JSON in the
 * browser — which is exactly what it used to do.
 */
export function useExportDownload() {
  return useMutation({
    mutationFn: (exportId: string) =>
      apiFetch(`/api/v1/exports/${exportId}/download`, { schema: exportDownloadResponse }),
  });
}

// --- Productions ---

export function useProductions() {
  return useQuery({
    queryKey: ['productions'],
    queryFn: () => apiFetch('/api/v1/productions?limit=100', { schema: productionListResponse }),
  });
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'rendering', 'stamping', 'verifying']);

export function useProduction(id: string) {
  return useQuery({
    queryKey: ['production', id],
    queryFn: () => apiFetch(`/api/v1/productions/${id}`, { schema: productionDetail }),
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => ACTIVE_RUN_STATUSES.has(r.status)) ? 2000 : false,
  });
}

export function useCreateProduction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/v1/productions', { method: 'POST', body, schema: createdIdResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['productions'] }),
  });
}

export function useValidateProduction() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/productions/${id}/validate`, {
        method: 'POST',
        body: {},
        schema: validateProductionResponse,
      }),
  });
}

export function useSubmitProduction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/api/v1/productions/${id}/submit`, {
        method: 'POST',
        body,
        schema: submitProductionResponse,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['production', id] }),
  });
}

export function useProductionExceptions(id: string) {
  return useQuery({
    queryKey: ['production-exceptions', id],
    queryFn: () =>
      apiFetch(`/api/v1/productions/${id}/exceptions?limit=100`, { schema: exceptionListResponse }),
  });
}

// --- Audit / members ---

export function useAuditPage(cursor: string | null) {
  return useQuery({
    queryKey: ['audit', cursor],
    queryFn: () =>
      apiFetch(`/api/v1/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        schema: auditListResponse,
      }),
    placeholderData: keepPreviousData,
  });
}

export function useAuditVerify() {
  return useMutation({
    mutationFn: () => apiFetch('/api/v1/audit/verify', { schema: auditVerifyResponse }),
  });
}

export function useMembers(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['members', tenantId],
    queryFn: () =>
      apiFetch(`/api/v1/tenants/${tenantId}/members?limit=100`, { schema: memberListResponse }),
    enabled: Boolean(tenantId),
  });
}
