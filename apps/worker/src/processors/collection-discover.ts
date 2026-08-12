import { appendAuditEvent, withTenantContext, type Prisma } from '@evidencevault/database';
import { GMAIL_ACCOUNT_FOLDER } from '@evidencevault/connectors';
import type { CollectionScope } from '@evidencevault/contracts';
import { sanitizeError, type WorkerContext } from '../context.js';
import {
  buildAuditConnectors,
  buildConnectorsForAccount,
  makeRateLimitObserver,
  type ConnectorBundle,
} from '../connector-factory.js';
import { AuditRequiresOrganizationModeError, composeAuditScopeKey } from '../audit.js';
import { recordException } from '../progress.js';
import { QUEUES, dedupKeys } from '../queues.js';
import { emailFolderIncluded, parseCollectionScope } from '../scope.js';
import type { DiscoverPayload } from './payloads.js';

/** Sentinel scopeKey for the custodian's default drive (no explicit driveId). */
export const DEFAULT_DRIVE_SCOPE_KEY = '__default__';

/**
 * Synthetic custodian representing the organization for org-scoped audit-log
 * collection. Audit logs are tenant-wide, not per-user, but checkpoints and
 * items require a custodian row: one "(org audit)" custodian per connector.
 */
export const ORG_AUDIT_EXTERNAL_ID = '__org_audit__';
export const ORG_AUDIT_LABEL = '(org audit)';

interface DiscoveredScope {
  custodianId: string;
  source: 'email' | 'drive' | 'audit';
  scopeKey: string;
}

async function discoverEmailScopeKeys(
  bundle: ConnectorBundle,
  scope: CollectionScope,
  onPermissionException: (
    kind: 'permission_denied' | 'unavailable_item',
    message: string,
  ) => Promise<void>,
): Promise<string[]> {
  const emailScope = scope.email ?? {
    folderIds: null,
    includeSpam: false,
    includeTrash: false,
    includeRecoverableItems: false,
  };
  if (bundle.provider === 'google') {
    // Gmail lists at account level; explicit label ids become per-label scopes.
    if (emailScope.folderIds !== null && emailScope.folderIds.length > 0) {
      return emailScope.folderIds;
    }
    return [GMAIL_ACCOUNT_FOLDER];
  }
  const discovery = await bundle.email.listMailFolders(bundle.custodianRef);
  for (const exception of discovery.exceptions) {
    if (exception.kind === 'permission_denied' || exception.kind === 'unavailable_item') {
      await onPermissionException(exception.kind, exception.message);
    }
  }
  return discovery.folders
    .filter((folder) => emailFolderIncluded(folder, bundle.provider, emailScope))
    .map((folder) => folder.id);
}

async function discoverDriveScopeKeys(
  bundle: ConnectorBundle,
  scope: CollectionScope,
): Promise<string[]> {
  const driveScope = scope.drive ?? {
    driveIds: null,
    folderIds: null,
    includeSharedDrives: false,
    includeTrashed: false,
  };
  if (driveScope.driveIds !== null && driveScope.driveIds.length > 0) {
    return driveScope.driveIds;
  }
  if (!driveScope.includeSharedDrives) {
    return [DEFAULT_DRIVE_SCOPE_KEY];
  }
  const drives = await bundle.drive.listDrives(bundle.custodianRef);
  if (bundle.provider === 'google') {
    // Google listDrives returns shared drives only; My Drive is always included.
    return [DEFAULT_DRIVE_SCOPE_KEY, ...drives.map((d) => d.id)];
  }
  // Microsoft listDrives includes the default drive.
  return drives.length > 0 ? drives.map((d) => d.id) : [DEFAULT_DRIVE_SCOPE_KEY];
}

/**
 * Ensure the synthetic "(org audit)" custodian and its collection link exist,
 * then enumerate every audit scope across the org-scoped audit connectors.
 * Returns discovered scopes keyed by a composite `${system}::${scopeKey}` so
 * fetch-page can route each scope back to its owning connector/system.
 */
async function discoverAuditScopes(
  ctx: WorkerContext,
  tenantId: string,
  collectionId: string,
  collection: { connectorAccountId: string },
  scope: CollectionScope,
): Promise<DiscoveredScope[]> {
  const bundle = await buildAuditConnectors(ctx, {
    tenantId,
    connectorAccountId: collection.connectorAccountId,
    auditScope: scope.audit,
    onRateLimit: makeRateLimitObserver(ctx, tenantId, collectionId, ORG_AUDIT_EXTERNAL_ID, 'audit'),
  });

  // Ensure the org custodian + its collection link (idempotent upserts).
  const orgCustodianId = await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const custodian = await tx.custodian.upsert({
      where: {
        connectorAccountId_externalId: {
          connectorAccountId: collection.connectorAccountId,
          externalId: ORG_AUDIT_EXTERNAL_ID,
        },
      },
      create: {
        tenantId,
        connectorAccountId: collection.connectorAccountId,
        externalId: ORG_AUDIT_EXTERNAL_ID,
        email: ORG_AUDIT_LABEL,
        displayName: ORG_AUDIT_LABEL,
      },
      update: {},
      select: { id: true },
    });
    await tx.collectionCustodian.upsert({
      where: { collectionId_custodianId: { collectionId, custodianId: custodian.id } },
      create: { tenantId, collectionId, custodianId: custodian.id },
      update: {},
    });
    return custodian.id;
  });

  const scopes: DiscoveredScope[] = [];
  for (const tagged of bundle.connectors) {
    const listed = await tagged.connector.listAuditScopes();
    for (const auditScope of listed) {
      scopes.push({
        custodianId: orgCustodianId,
        source: 'audit',
        scopeKey: composeAuditScopeKey(tagged.kind, auditScope.scopeKey),
      });
    }
  }
  return scopes;
}

/**
 * collection.discover: enumerate folders/drives per custodian x source, then
 * atomically seed checkpoints + first fetch-page outbox events and move the
 * collection to `fetching`. Idempotent: checkpoints and outbox rows are
 * unique-keyed, and re-discovery upserts rather than duplicating.
 */
export async function processCollectionDiscover(
  ctx: WorkerContext,
  payload: DiscoverPayload,
): Promise<void> {
  const { tenantId, collectionId } = payload;

  const collection = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.collection.findUnique({
      where: { id: collectionId },
      include: { custodians: { include: { custodian: true } } },
    }),
  );
  if (collection === null) {
    ctx.log.warn({ collectionId }, 'discover: collection not found; dropping job');
    return;
  }
  if (!['created', 'discovering', 'fetching'].includes(collection.status)) {
    ctx.log.info({ collectionId, status: collection.status }, 'discover: refused for status');
    return;
  }

  const scope = parseCollectionScope(collection.scope);

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.collection.update({
      where: { id: collectionId },
      data: { status: 'discovering', startedAt: collection.startedAt ?? new Date() },
    });
    await appendAuditEvent(tx, {
      tenantId,
      action: 'collection.discovery_started',
      targetType: 'collection',
      targetId: collectionId,
      actorDisplay: 'worker',
      summary: { sources: collection.sources },
    });
  });

  const discovered: DiscoveredScope[] = [];
  const folderCounts: Record<string, number> = {};
  let attempted = 0;
  let failed = 0;

  // Per-custodian sources (email/drive). Audit is org-scoped and handled once
  // below, so it is skipped here even if custodians happen to be present.
  const perCustodianSources = collection.sources.filter((s) => s !== 'audit');
  for (const collectionCustodian of collection.custodians) {
    const custodian = collectionCustodian.custodian;
    for (const source of perCustodianSources) {
      attempted += 1;
      try {
        const bundle = await buildConnectorsForAccount(ctx, {
          tenantId,
          connectorAccountId: collection.connectorAccountId,
          custodian: { externalId: custodian.externalId, email: custodian.email },
          onRateLimit: makeRateLimitObserver(ctx, tenantId, collectionId, custodian.id, source),
        });
        const scopeKeys =
          source === 'email'
            ? await discoverEmailScopeKeys(bundle, scope, (kind, message) =>
                withTenantContext(ctx.prisma, tenantId, (tx) =>
                  recordException(tx, {
                    tenantId,
                    collectionId,
                    custodianId: custodian.id,
                    source,
                    kind,
                    message,
                  }),
                ),
              )
            : await discoverDriveScopeKeys(bundle, scope);
        folderCounts[`${custodian.email}:${source}`] = scopeKeys.length;
        for (const scopeKey of scopeKeys) {
          discovered.push({ custodianId: custodian.id, source, scopeKey });
        }
      } catch (err) {
        failed += 1;
        const message = sanitizeError(err);
        ctx.log.warn(
          { collectionId, custodianId: custodian.id, source, err: message },
          'discover: custodian/source enumeration failed',
        );
        await withTenantContext(ctx.prisma, tenantId, (tx) =>
          recordException(tx, {
            tenantId,
            collectionId,
            custodianId: custodian.id,
            source,
            kind: 'api_error',
            message: `discovery failed: ${message}`,
          }),
        );
      }
    }
  }

  // Organization-scoped audit enumeration (once per collection).
  if (collection.sources.includes('audit')) {
    attempted += 1;
    try {
      const auditScopes = await discoverAuditScopes(ctx, tenantId, collectionId, collection, scope);
      folderCounts['(org audit)'] = auditScopes.length;
      discovered.push(...auditScopes);
    } catch (err) {
      failed += 1;
      const message = sanitizeError(err);
      const permission = err instanceof AuditRequiresOrganizationModeError;
      ctx.log.warn({ collectionId, err: message }, 'discover: audit enumeration failed');
      await withTenantContext(ctx.prisma, tenantId, (tx) =>
        recordException(tx, {
          tenantId,
          collectionId,
          source: 'audit',
          kind: permission ? 'permission_denied' : 'api_error',
          message: permission ? message : `audit discovery failed: ${message}`,
        }),
      );
    }
  }

  if (attempted > 0 && failed === attempted) {
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.collection.update({
        where: { id: collectionId },
        data: { status: 'failed', finishedAt: new Date() },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'collection.discovery_failed',
        targetType: 'collection',
        targetId: collectionId,
        actorDisplay: 'worker',
        summary: { attempted, failed },
      });
    });
    return;
  }

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    const outboxRows: Prisma.OutboxEventCreateManyInput[] = [];
    for (const item of discovered) {
      await tx.collectionCheckpoint.upsert({
        where: {
          collectionId_custodianId_source_scopeKey: {
            collectionId,
            custodianId: item.custodianId,
            source: item.source,
            scopeKey: item.scopeKey,
          },
        },
        create: {
          tenantId,
          collectionId,
          custodianId: item.custodianId,
          source: item.source,
          scopeKey: item.scopeKey,
          cursorKind: 'page',
          cursor: '',
          version: 0,
        },
        update: {},
      });
      outboxRows.push({
        tenantId,
        topic: QUEUES.collectionFetchPage,
        dedupKey: dedupKeys.collectionFetchPage(
          collectionId,
          item.custodianId,
          item.source,
          item.scopeKey,
          'start',
        ),
        payload: {
          tenantId,
          collectionId,
          custodianId: item.custodianId,
          source: item.source,
          scopeKey: item.scopeKey,
        },
      });
    }
    if (outboxRows.length > 0) {
      await tx.outboxEvent.createMany({ data: outboxRows, skipDuplicates: true });
    }
    await tx.collection.update({ where: { id: collectionId }, data: { status: 'fetching' } });
    await appendAuditEvent(tx, {
      tenantId,
      action: 'collection.discovery_completed',
      targetType: 'collection',
      targetId: collectionId,
      actorDisplay: 'worker',
      summary: { folderCounts, scopeCount: discovered.length, failedEnumerations: failed },
    });
  });
}
