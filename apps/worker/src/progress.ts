import type { Prisma, TenantScopedTx } from '@aeg-clouddfir/database';

/**
 * Per-custodian, per-source progress counters kept in
 * CollectionCustodian.progress (JSONB): { [source]: { discovered, ... } }.
 *
 * Incremented by a SINGLE atomic UPDATE whose SET expression reads the current
 * value in SQL. A read-modify-write in application code loses updates when
 * concurrent item transactions touch the same custodian row (observed: 54
 * counted of 71 actually preserved). Under READ COMMITTED, an UPDATE that
 * blocks on the row lock re-evaluates its SET expression against the winner's
 * committed row, so increments serialize instead of clobbering each other.
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

type CollectionSourceValue = 'email' | 'drive' | 'chat' | 'audit';

export async function incrementProgress(
  tx: TenantScopedTx,
  collectionId: string,
  custodianId: string,
  source: CollectionSourceValue,
  deltas: ProgressDeltas,
): Promise<void> {
  const d = (counter: ProgressCounter): number => {
    const value = deltas[counter];
    return value !== undefined && Number.isFinite(value) ? value : 0;
  };
  // Every counter is written as (current + delta); absent deltas add 0, which
  // also normalizes the bucket so the status API never sees missing keys.
  await tx.$executeRaw`
    UPDATE collection_custodians AS cc
    SET progress = jsonb_set(
          COALESCE(cc.progress, '{}'::jsonb),
          ARRAY[${source}::text],
          COALESCE(cc.progress -> ${source}::text, '{}'::jsonb) || jsonb_build_object(
            'discovered',    COALESCE((cc.progress -> ${source}::text ->> 'discovered')::bigint, 0)    + ${d('discovered')}::bigint,
            'fetched',       COALESCE((cc.progress -> ${source}::text ->> 'fetched')::bigint, 0)       + ${d('fetched')}::bigint,
            'preserved',     COALESCE((cc.progress -> ${source}::text ->> 'preserved')::bigint, 0)     + ${d('preserved')}::bigint,
            'parsed',        COALESCE((cc.progress -> ${source}::text ->> 'parsed')::bigint, 0)        + ${d('parsed')}::bigint,
            'ocrExtracted',  COALESCE((cc.progress -> ${source}::text ->> 'ocrExtracted')::bigint, 0)  + ${d('ocrExtracted')}::bigint,
            'indexed',       COALESCE((cc.progress -> ${source}::text ->> 'indexed')::bigint, 0)       + ${d('indexed')}::bigint,
            'warnings',      COALESCE((cc.progress -> ${source}::text ->> 'warnings')::bigint, 0)      + ${d('warnings')}::bigint,
            'failures',      COALESCE((cc.progress -> ${source}::text ->> 'failures')::bigint, 0)      + ${d('failures')}::bigint,
            'retries',       COALESCE((cc.progress -> ${source}::text ->> 'retries')::bigint, 0)       + ${d('retries')}::bigint,
            'rateLimitWaitMs', COALESCE((cc.progress -> ${source}::text ->> 'rateLimitWaitMs')::bigint, 0) + ${d('rateLimitWaitMs')}::bigint
          ),
          true)
    WHERE cc."collectionId" = ${collectionId}::uuid
      AND cc."custodianId" = ${custodianId}::uuid`;
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
