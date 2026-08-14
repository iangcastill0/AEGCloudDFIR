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
  collectionStatusResponse,
  validateProductionResponse,
  createExportResponse,
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
  previewResponse,
  productionDetail,
  productionListResponse,
  rawSearchResponse,
  type RawSearchResponse,
  type SearchResponse,
  submitProductionResponse,
  tagListResponse,
  savedSearchListResponse,
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

export interface CreateConnectorInput {
  provider: 'microsoft' | 'google';
  mode: 'delegated' | 'organization';
  organization?: {
    entraTenantId?: string;
    serviceAccountJson?: string;
    allowedDomains?: string[];
    adminEmail?: string;
  };
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
    mutationFn: (id: string) => apiFetch(`/api/v1/connectors/${id}/revoke`, { method: 'POST' }),
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
      apiFetch(`/api/v1/collections/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collection', id] }),
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

/** Compose the API's single query string from the rail's filters. */
export function composeQuery(input: SearchRequestInput): string {
  const parts: string[] = [];
  const text = input.queryText.trim();
  if (text.length > 0) parts.push(`(${text})`);
  if (input.custodianEmail) parts.push(`custodian:${input.custodianEmail.trim()}`);
  if (input.source === 'email') parts.push('(type:email OR type:attachment)');
  if (input.source === 'drive') parts.push('type:file');
  for (const [field, values] of Object.entries(input.facetFilters ?? {})) {
    const queryField = FACET_QUERY_FIELDS[field];
    if (!queryField || values.length === 0) continue;
    const clause = values.map((v) => `${queryField}:"${v.replaceAll('"', '')}"`).join(' OR ');
    parts.push(values.length > 1 ? `(${clause})` : clause);
  }
  return parts.join(' AND ');
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

export function useSearch(input: SearchRequestInput, enabled: boolean) {
  return useQuery({
    queryKey: ['search', input],
    queryFn: async () => {
      const raw = await apiFetch('/api/v1/search', {
        method: 'POST',
        body: {
          query: composeQuery(input),
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

export function useEvidence(id: string | null) {
  return useQuery({
    queryKey: ['evidence', id],
    queryFn: async () => {
      // The custody chain lives on its own endpoint; merge it into the
      // detail object the panel renders.
      const [detail, chain] = await Promise.all([
        apiFetch(`/api/v1/evidence/${id}`, { schema: evidenceDetail }),
        apiFetch(`/api/v1/evidence/${id}/chain`, { schema: rawChainResponse }).catch(() => null),
      ]);
      if (chain === null) return detail;
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
      return { ...detail, custody: [...acquisitionEntry, ...chain.events] };
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
    mutationFn: (body: { name: string; caseId?: string; queryText: string; queryAst: unknown }) =>
      apiFetch('/api/v1/saved-searches', { method: 'POST', body, schema: savedSearchResponse }),
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
      apiFetch(`/api/v1/cases/${id}`, { method: 'PATCH', body, schema: caseResponse }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['case', id] });
      void qc.invalidateQueries({ queryKey: ['cases'] });
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case-notes', id] }),
  });
}

export function useAddCaseItems(id: string) {
  return useMutation({
    mutationFn: (body: unknown) => apiFetch(`/api/v1/cases/${id}/items`, { method: 'POST', body }),
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
