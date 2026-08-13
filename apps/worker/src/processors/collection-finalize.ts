import {
  buildManifest,
  renderCompletenessReport,
  serializeManifest,
  signManifest,
  type BuildManifestInput,
  type Completeness,
  type ManifestException,
  type ManifestItem,
} from '@aeg-clouddfir/evidence';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import {
  EvidenceKind,
  ProcessingStatus,
  appendAuditEvent,
  withTenantContext,
} from '@aeg-clouddfir/database';
import type { WorkerContext } from '../context.js';
import { parseCollectionScope } from '../scope.js';
import type { FinalizePayload } from './payloads.js';

/** Static per-provider API surface documented in manifests. */
const API_ENDPOINTS: Record<'microsoft' | 'google' | 'upload', string[]> = {
  microsoft: [
    'GET /v1.0/{user}/mailFolders',
    'GET /v1.0/{user}/mailFolders/{id}/messages',
    'GET /v1.0/{user}/messages/{id}',
    'GET /v1.0/{user}/messages/{id}/$value',
    'GET /v1.0/{user}/mailFolders/{id}/messages/delta',
    'GET /v1.0/{user}/drive | /v1.0/{user}/drives',
    'GET /v1.0/drives/{id}/root/delta',
    'GET /v1.0/drives/{id}/items/{id}/content',
  ],
  google: [
    'GET gmail/v1/users/me/labels',
    'GET gmail/v1/users/me/messages',
    'GET gmail/v1/users/me/messages/{id}?format=raw',
    'GET gmail/v1/users/me/history',
    'GET drive/v3/files | drive/v3/drives',
    'GET drive/v3/files/{id}?alt=media',
    'GET drive/v3/files/{id}/export',
    'GET drive/v3/changes',
  ],
  // Uploaded container files: no provider API is involved.
  upload: ['upload'],
};

interface StateCounts {
  discovered: number;
  fetching: number;
  preserved: number;
  processed: number;
  indexed: number;
  failed: number;
  skipped: number;
}

export function decideCompleteness(input: {
  wasCancelling: boolean;
  preserved: number;
  errors: number;
  exceptionCount: number;
}): Completeness {
  if (input.wasCancelling) return 'cancelled';
  if (input.preserved === 0 && input.errors > 0) return 'failed';
  if (input.errors > 0) return 'partial';
  if (input.exceptionCount > 0) return 'complete_with_exceptions';
  return 'complete_within_selected_api_scope';
}

export function buildCompletenessNarrative(input: {
  completeness: Completeness;
  preserved: number;
  discovered: number;
  errors: number;
  skipped: number;
  exceptionCount: number;
  provider: string;
  mode: string;
  allTimeScope: boolean;
}): string {
  const parts: string[] = [];
  if (input.provider === 'upload') {
    parts.push(
      `Preserved ${input.preserved} of ${input.discovered} discovered item(s) from uploaded ` +
        `container files. Messages extracted from containers are reconstructions built from ` +
        `each container's stored properties, not provider-native items; the uploaded ` +
        `containers remain the authoritative originals.`,
    );
  } else {
    parts.push(
      `Preserved ${input.preserved} of ${input.discovered} discovered item(s) via the ` +
        `${input.provider} API using ${input.mode} permissions.`,
    );
  }
  if (input.errors > 0) {
    parts.push(`${input.errors} item(s) could not be preserved and are recorded as failures.`);
  }
  if (input.skipped > 0) {
    parts.push(`${input.skipped} item(s) were skipped and are recorded in the exception ledger.`);
  }
  if (input.exceptionCount > 0) {
    parts.push(`${input.exceptionCount} exception(s) were recorded during collection.`);
  }
  if (input.provider === 'upload') {
    parts.push(TRUTHFULNESS_NOTICES.pstExtraction);
  } else {
    parts.push(
      'Completeness is always relative to the connected account, its permissions, and the API-visible scope.',
    );
    if (input.allTimeScope) {
      parts.push(TRUTHFULNESS_NOTICES.allTimeScope);
    }
  }
  return parts.join(' ');
}

/**
 * collection.finalize: repeated-check tolerant. When no items or page
 * checkpoints remain in flight, compute honest completeness, build + sign the
 * manifest, store it with a human-readable report, and close the collection.
 */
export async function processCollectionFinalize(
  ctx: WorkerContext,
  payload: FinalizePayload,
): Promise<void> {
  const { tenantId, collectionId } = payload;

  const snapshot = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const collection = await tx.collection.findUnique({
      where: { id: collectionId },
      include: {
        custodians: { include: { custodian: true } },
        connectorAccount: true,
      },
    });
    if (collection === null) return null;
    const grouped = await tx.collectionItem.groupBy({
      by: ['state'],
      where: { collectionId },
      _count: { _all: true },
    });
    const pageCheckpoints = await tx.collectionCheckpoint.count({
      where: { collectionId, cursorKind: 'page' },
    });
    // process.parse and search.index are enqueued in PARALLEL, so an item
    // reaching CollectionItem state 'indexed' does NOT imply its parse ran —
    // and parse is what creates attachment children. Sealing before every
    // parent is parsed omits those children (observed: 126 of 142 items).
    //
    // Gate on exactly that condition — parents still awaiting parse — and NOT
    // on full pipeline settlement: children are written with their hash at
    // creation, so once parents are parsed the manifest is complete, and
    // waiting on downstream stages (extract/OCR/index) would stall on paths
    // that end in an exception status instead of 'indexed'.
    const unparsedParents = await tx.evidenceItem.count({
      where: {
        collectionId,
        kind: { in: [EvidenceKind.email, EvidenceKind.container] },
        processingStatus: ProcessingStatus.pending,
      },
    });
    const exceptions = await tx.collectionException.findMany({
      where: { collectionId },
      orderBy: { occurredAt: 'asc' },
      take: 5000,
    });
    return { collection, grouped, pageCheckpoints, exceptions, unparsedParents };
  });

  if (snapshot === null) {
    ctx.log.warn({ collectionId }, 'finalize: collection not found; dropping');
    return;
  }
  const { collection, grouped, pageCheckpoints, exceptions, unparsedParents } = snapshot;
  if (!['fetching', 'cancelling', 'finalizing'].includes(collection.status)) {
    return; // already finalized, paused, or failed elsewhere
  }

  const counts: StateCounts = {
    discovered: 0,
    fetching: 0,
    preserved: 0,
    processed: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of grouped) {
    counts[row.state as keyof StateCounts] = row._count._all;
  }
  // 'preserved' means the bytes are stored but the processing pipeline has not
  // settled: parse creates attachment children AFTER an item is preserved, so
  // sealing the manifest here would omit them (observed: 123 of 142 items).
  // Wait for every item to reach a terminal state — indexed/processed/failed/
  // skipped — which is also when all child items exist. search-index (the last
  // stage) and the permanent-failure paths enqueue the check that gets us here.
  const inFlight = counts.discovered + counts.fetching + counts.preserved;
  if (
    collection.status === 'fetching' &&
    (inFlight > 0 || pageCheckpoints > 0 || unparsedParents > 0)
  ) {
    return; // not done yet; another check will arrive
  }

  const wasCancelling = collection.status === 'cancelling';
  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.collection.update({ where: { id: collectionId }, data: { status: 'finalizing' } }),
  );

  const preservedTotal = counts.preserved + counts.processed + counts.indexed;
  const totalDiscovered =
    counts.discovered + counts.fetching + preservedTotal + counts.failed + counts.skipped;
  const completeness = decideCompleteness({
    wasCancelling,
    preserved: preservedTotal,
    errors: counts.failed,
    exceptionCount: exceptions.length,
  });

  const scope = parseCollectionScope(collection.scope);
  const provider = collection.connectorAccount.provider as 'microsoft' | 'google' | 'upload';
  const mode = collection.connectorAccount.mode as 'delegated' | 'organization';

  const narrative = buildCompletenessNarrative({
    completeness,
    preserved: preservedTotal,
    discovered: totalDiscovered,
    errors: counts.failed,
    skipped: counts.skipped,
    exceptionCount: exceptions.length,
    provider,
    mode,
    allTimeScope: scope.dateRange.kind === 'all_time',
  });

  // Manifest items: every evidence item preserved into this collection.
  const evidenceItems = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceItem.findMany({
      where: { collectionId },
      include: { blob: { select: { objectKey: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  );
  const manifestItems: ManifestItem[] = evidenceItems
    .filter((item) => item.sha256 !== '')
    .map((item) => ({
      evidenceItemId: item.id,
      providerItemId: item.providerItemId,
      custodianId: item.custodianId ?? '',
      sha256: item.sha256,
      size: Number(item.size),
      objectKey: item.blob?.objectKey ?? '',
      acquiredAt: item.acquiredAt.toISOString(),
      ...(item.isApiExportDerivative ? { apiExportDerivative: true } : {}),
    }));

  const manifestExceptions: ManifestException[] = exceptions.map((ex) => ({
    kind: ex.kind,
    message: ex.message,
    ...(ex.providerItemId !== '' ? { providerItemId: ex.providerItemId } : {}),
    ...(ex.custodianId !== null ? { custodianId: ex.custodianId } : {}),
  }));

  const manifestInput: BuildManifestInput = {
    application: {
      name: 'AEG-CloudDFIR',
      version: ctx.config.CDFIR_APP_VERSION,
      parserVersions: {},
    },
    collection: {
      id: collection.id,
      tenantId,
      name: collection.name,
      kind: collection.kind,
      permissionMode: mode,
      // The evidence manifest schema predates the synthetic 'upload'
      // provider; the value passes through verbatim into the manifest JSON.
      provider: provider as 'microsoft' | 'google',
      connectorLabel: collection.connectorAccount.label,
      connectorExternalIdentity: collection.connectorAccount.externalIdentity,
      custodians: collection.custodians.map((cc) => ({
        id: cc.custodian.id,
        email: cc.custodian.email,
        displayName: cc.custodian.displayName,
      })),
      scope: collection.scope,
      startedAt: collection.startedAt?.toISOString() ?? '',
      finishedAt: new Date().toISOString(),
      apiEndpoints: API_ENDPOINTS[provider],
    },
    counts: {
      discovered: totalDiscovered,
      fetched: preservedTotal + counts.failed,
      preserved: preservedTotal,
      skipped: counts.skipped,
      errors: counts.failed,
    },
    completeness,
    completenessNarrative: narrative,
    exceptions: manifestExceptions,
    items: manifestItems,
  };

  const manifest = buildManifest(manifestInput);
  const serialized = serializeManifest(manifest);
  const signature = signManifest(serialized, ctx.manifestSigningKey, 'manifest-signing-v1');
  // Envelope embeds the exact signed bytes so verification is byte-stable.
  const envelope = `{"manifest":${serialized},"signature":${JSON.stringify(signature)}}`;
  const stored = await ctx.store.putManifest(tenantId, collectionId, envelope);

  // Human-readable completeness report stored beside the manifest (derivative
  // keyspace keyed by the collection id).
  const report = renderCompletenessReport(manifest);
  await ctx.store.putDerivative(
    tenantId,
    collectionId,
    'completeness-report',
    1,
    'report.txt',
    Buffer.from(report, 'utf8'),
    'text/plain; charset=utf-8',
  );

  const finalStatus =
    completeness === 'cancelled' ? 'cancelled' : completeness === 'failed' ? 'failed' : 'completed';

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.collection.update({
      where: { id: collectionId },
      data: {
        status: finalStatus,
        completeness,
        finishedAt: new Date(),
        cancelledAt: finalStatus === 'cancelled' ? new Date() : null,
        manifestKey: stored.objectKey,
        manifestSha256: stored.sha256,
      },
    });
    await appendAuditEvent(tx, {
      tenantId,
      action: 'collection.finalized',
      targetType: 'collection',
      targetId: collectionId,
      actorDisplay: 'worker',
      summary: {
        completeness,
        counts: manifestInput.counts as unknown as Record<string, unknown>,
        manifestSha256: stored.sha256,
        exceptionCount: exceptions.length,
        // Continuous collections keep their delta/history checkpoints so
        // incremental sync remains active after finalization.
        incrementalSyncActive: collection.kind === 'continuous' && finalStatus === 'completed',
      },
    });
  });
}
