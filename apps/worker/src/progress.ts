import type { Prisma, TenantScopedTx } from '@evidencevault/database';

/**
 * Per-custodian, per-source progress counters kept in
 * CollectionCustodian.progress (JSONB): { [source]: { discovered, ... } }.
 * Always mutated read-modify-write INSIDE the caller's tenant transaction so
 * counter updates commit atomically with the durable results they describe.
 */
export const PROGRESS_COUNTERS = [
  'discovered',
  'fetched',
  'preserved',
  'parsed',
  'ocrExtracted',
  'indexed',
  'warnings',
  'failures',
  'retries',
  'rateLimitWaitMs',
] as const;

export type ProgressCounter = (typeof PROGRESS_COUNTERS)[number];
export type ProgressDeltas = Partial<Record<ProgressCounter, number>>;

type CollectionSourceValue = 'email' | 'drive' | 'audit';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function incrementProgress(
  tx: TenantScopedTx,
  collectionId: string,
  custodianId: string,
  source: CollectionSourceValue,
  deltas: ProgressDeltas,
): Promise<void> {
  const row = await tx.collectionCustodian.findUnique({
    where: { collectionId_custodianId: { collectionId, custodianId } },
    select: { id: true, progress: true },
  });
  if (row === null) return;

  const progress: Record<string, unknown> = isRecord(row.progress) ? { ...row.progress } : {};
  const existing = progress[source];
  const bucket: Record<string, number> = {};
  if (isRecord(existing)) {
    for (const counter of PROGRESS_COUNTERS) {
      const value = existing[counter];
      if (typeof value === 'number' && Number.isFinite(value)) bucket[counter] = value;
    }
  }
  for (const counter of PROGRESS_COUNTERS) {
    const delta = deltas[counter];
    if (delta !== undefined && delta !== 0) {
      bucket[counter] = (bucket[counter] ?? 0) + delta;
    }
  }
  progress[source] = bucket;

  await tx.collectionCustodian.update({
    where: { id: row.id },
    data: { progress: progress as Prisma.InputJsonValue },
  });
}

/** Prisma ExceptionKind values (mirrored as literals to stay import-light in tests). */
export type CollectionExceptionKind =
  | 'unavailable_item'
  | 'unsupported_item'
  | 'non_downloadable'
  | 'encrypted_item'
  | 'rights_managed'
  | 'corrupt_item'
  | 'throttled_skip'
  | 'expired_checkpoint'
  | 'permission_denied'
  | 'api_error'
  | 'api_export_derivative'
  | 'quarantined'
  | 'other';

export interface CollectionExceptionInput {
  tenantId: string;
  collectionId: string;
  custodianId?: string;
  source?: CollectionSourceValue;
  providerItemId?: string;
  kind: CollectionExceptionKind;
  message: string;
  detail?: Record<string, unknown>;
}

export async function recordException(
  tx: TenantScopedTx,
  input: CollectionExceptionInput,
): Promise<void> {
  await tx.collectionException.create({
    data: {
      tenantId: input.tenantId,
      collectionId: input.collectionId,
      custodianId: input.custodianId ?? null,
      source: input.source ?? null,
      providerItemId: input.providerItemId ?? '',
      kind: input.kind,
      message: input.message.slice(0, 1000),
      detail: (input.detail ?? {}) as Prisma.InputJsonValue,
    },
  });
}
