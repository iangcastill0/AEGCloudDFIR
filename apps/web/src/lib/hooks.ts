'use client';
/** React Query hooks for the EvidenceVault API. */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  collectionStatusResponse,
  validateProductionResponse,
  exportStatusResponse,
  tagResponse,
  savedSearchResponse,
  caseResponse,
} from '@evidencevault/contracts';
import type { CreateCollectionRequest } from '@evidencevault/contracts';
import { apiFetch } from './api';
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
  explainResponse,
  exportListResponse,
  logoutResponse,
  meResponse,
  memberListResponse,
  previewResponse,
  productionDetail,
  productionListResponse,
  searchResponse,
  submitProductionResponse,
  tagListResponse,
  savedSearchListResponse,
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

export function useCustodians(connectorId: string, search: string) {
  return useQuery({
    queryKey: ['custodians', connectorId, search],
    queryFn: () =>
      apiFetch(
        `/api/v1/connectors/${connectorId}/custodians?limit=50&query=${encodeURIComponent(search)}`,
        { schema: custodianListResponse },
      ),
    enabled: connectorId.length > 0,
    placeholderData: keepPreviousData,
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
    mutationFn: (body: CreateCollectionRequest) =>
      apiFetch('/api/v1/collections', { method: 'POST', body, schema: createdIdResponse }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  });
}

export function useCollectionAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel' | 'retry') =>
      apiFetch(`/api/v1/collections/${id}/actions`, { method: 'POST', body: { action } }),
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

export function useSearch(input: SearchRequestInput, enabled: boolean) {
  return useQuery({
    queryKey: ['search', input],
    queryFn: () =>
      apiFetch('/api/v1/search', {
        method: 'POST',
        body: { limit: 100, ...input },
        schema: searchResponse,
      }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useExplain(queryText: string, evidenceItemId: string | null) {
  return useQuery({
    queryKey: ['explain', queryText, evidenceItemId],
    queryFn: () =>
      apiFetch('/api/v1/search/explain', {
        method: 'POST',
        body: { queryText, evidenceItemId },
        schema: explainResponse,
      }),
    enabled: evidenceItemId !== null && queryText.length > 0,
  });
}

export function useEvidence(id: string | null) {
  return useQuery({
    queryKey: ['evidence', id],
    queryFn: () => apiFetch(`/api/v1/evidence/${id}`, { schema: evidenceDetail }),
    enabled: id !== null,
  });
}

export function useEvidencePreview(id: string | null) {
  return useQuery({
    queryKey: ['evidence-preview', id],
    queryFn: () => apiFetch(`/api/v1/evidence/${id}/preview`, { schema: previewResponse }),
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
      apiFetch('/api/v1/exports', { method: 'POST', body, schema: exportStatusResponse }),
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
