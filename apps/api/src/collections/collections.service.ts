import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CollectionItemState,
  CollectionStatus,
  ConnectorStatus,
  Prisma,
  withTenantContext,
  type PrismaClient,
} from '@evidencevault/database';
import {
  collectionAction,
  createCollectionRequest,
  type CollectionStatusResponse,
} from '@evidencevault/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk } from '../common/families.js';
import { AuditService } from '../audit/audit.service.js';

/** Statuses that count against the concurrent-collections quota. */
const ACTIVE_STATUSES: CollectionStatus[] = [
  CollectionStatus.created,
  CollectionStatus.discovering,
  CollectionStatus.fetching,
  CollectionStatus.processing,
  CollectionStatus.finalizing,
];

export type CollectionActionName = 'pause' | 'resume' | 'cancel' | 'retry';

/** Legal source statuses per action. Anything else is a 409. */
const LEGAL_TRANSITIONS: Record<CollectionActionName, CollectionStatus[]> = {
  pause: [
    CollectionStatus.created,
    CollectionStatus.discovering,
    CollectionStatus.fetching,
    CollectionStatus.processing,
  ],
  resume: [CollectionStatus.paused],
  cancel: [
    CollectionStatus.created,
    CollectionStatus.discovering,
    CollectionStatus.fetching,
    CollectionStatus.processing,
    CollectionStatus.paused,
  ],
  retry: [CollectionStatus.failed, CollectionStatus.completed],
};

const RETRY_ITEM_CAP = 1000;
const RETRY_BATCH_SIZE = 200;

const COMPLETENESS_NARRATIVES: Record<string, string> = {
  complete_within_selected_api_scope:
    'All items the provider API returned within the selected account, permissions, scope and retention state were collected.',
  complete_with_exceptions:
    'Collection finished, but some items produced exceptions; see the exception ledger and manifest.',
  partial: 'Collection stopped before covering the full selected scope.',
  failed: 'Collection failed before completing; collected items remain preserved.',
  cancelled: 'Collection was cancelled; items collected before cancellation remain preserved.',
};

export interface CollectionListItem {
  id: string;
  name: string;
  kind: string;
  status: string;
  connectorAccountId: string;
  sources: string[];
  completeness: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface ProgressCounters {
  discovered: number;
  fetched: number;
  preserved: number;
  parsed: number;
  ocrExtracted: number;
  indexed: number;
  warnings: number;
  failures: number;
  retries: number;
  rateLimitWaitMs: number;
  checkpoint: string | null;
}

function readCounters(progress: unknown, source: string): ProgressCounters {
  const zero: ProgressCounters = {
    discovered: 0,
    fetched: 0,
    preserved: 0,
    parsed: 0,
    ocrExtracted: 0,
    indexed: 0,
    warnings: 0,
    failures: 0,
    retries: 0,
    rateLimitWaitMs: 0,
    checkpoint: null,
  };
  if (typeof progress !== 'object' || progress === null) return zero;
  const perSource = (progress as Record<string, unknown>)[source];
  if (typeof perSource !== 'object' || perSource === null) return zero;
  const record = perSource as Record<string, unknown>;
  const num = (key: string): number =>
    typeof record[key] === 'number' ? (record[key] as number) : 0;
  return {
    discovered: num('discovered'),
    fetched: num('fetched'),
    preserved: num('preserved'),
    parsed: num('parsed'),
    ocrExtracted: num('ocrExtracted'),
    indexed: num('indexed'),
    warnings: num('warnings'),
    failures: num('failures'),
    retries: num('retries'),
    rateLimitWaitMs: num('rateLimitWaitMs'),
    checkpoint: typeof record.checkpoint === 'string' ? (record.checkpoint as string) : null,
  };
}

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async create(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ id: string; status: string; replayed: boolean }> {
    const input = zodValidate(createCollectionRequest, body);

    try {
      const result = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        // Idempotent replay: same key returns the existing collection.
        const existing = await tx.collection.findFirst({
          where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
          select: { id: true, status: true },
        });
        if (existing) return { id: existing.id, status: existing.status, replayed: true };

        const connector = await tx.connectorAccount.findFirst({
          where: { id: input.connectorAccountId, tenantId: auth.tenantId },
        });
        if (!connector) throw new NotFoundException();
        if (connector.status !== ConnectorStatus.connected) {
          throw new ConflictException('connector is not connected');
        }

        const custodians = await tx.custodian.findMany({
          where: {
            id: { in: input.custodianIds },
            tenantId: auth.tenantId,
            connectorAccountId: connector.id,
          },
          select: { id: true },
        });
        if (custodians.length !== input.custodianIds.length) {
          throw new BadRequestException('every custodianId must belong to the selected connector');
        }

        const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
        if (!tenant) throw new NotFoundException();
        const active = await tx.collection.count({
          where: { tenantId: auth.tenantId, status: { in: ACTIVE_STATUSES } },
        });
        assertWithinQuota(
          'maxConcurrentCollections',
          active,
          readQuota(tenant, 'maxConcurrentCollections'),
        );

        const collection = await tx.collection.create({
          data: {
            tenantId: auth.tenantId,
            connectorAccountId: connector.id,
            name: input.name,
            kind: input.kind,
            sources: input.sources,
            scope: input.scope as Prisma.InputJsonValue,
            status: CollectionStatus.created,
            idempotencyKey: input.idempotencyKey,
            createdById: auth.userId,
          },
        });
        await tx.collectionCustodian.createMany({
          data: input.custodianIds.map((custodianId) => ({
            tenantId: auth.tenantId,
            collectionId: collection.id,
            custodianId,
          })),
        });
        // Payload shape is the worker contract (apps/worker payloads.ts).
        await tx.outboxEvent.create({
          data: {
            tenantId: auth.tenantId,
            topic: 'collection.discover',
            dedupKey: `discover:${collection.id}`,
            payload: { tenantId: auth.tenantId, collectionId: collection.id },
          },
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'collection.created',
          targetType: 'collection',
          targetId: collection.id,
          summary: {
            name: input.name,
            sources: input.sources,
            custodianCount: input.custodianIds.length,
          },
          request,
        });
        return { id: collection.id, status: collection.status, replayed: false };
      });
      return result;
    } catch (err) {
      // Unique(tenantId, idempotencyKey) race: return the winner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
          tx.collection.findFirst({
            where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
            select: { id: true, status: true },
          }),
        );
        if (existing) return { id: existing.id, status: existing.status, replayed: true };
      }
      throw err;
    }
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: CollectionListItem[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.collection.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const slice = rows.slice(0, page.limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        status: c.status,
        connectorAccountId: c.connectorAccountId,
        sources: c.sources,
        completeness: c.completeness,
        createdAt: c.createdAt.toISOString(),
        startedAt: c.startedAt?.toISOString() ?? null,
        finishedAt: c.finishedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > page.limit && last ? last.id : null,
    };
  }

  async status(auth: AuthContext, id: string): Promise<CollectionStatusResponse> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { custodians: { include: { custodian: true } } },
      });
      if (!collection) throw new NotFoundException();

      const exceptionGroups = await tx.collectionException.groupBy({
        by: ['kind'],
        where: { tenantId: auth.tenantId, collectionId: id },
        _count: { _all: true },
      });
      const exceptionCounts: Record<string, number> = {};
      for (const group of exceptionGroups) {
        exceptionCounts[group.kind] = group._count._all;
      }

      const progress = collection.custodians.flatMap((cc) =>
        collection.sources.map((source) => ({
          custodianId: cc.custodianId,
          custodianEmail: cc.custodian.email,
          source,
          ...readCounters(cc.progress, source),
        })),
      );

      return {
        id: collection.id,
        name: collection.name,
        status: collection.status,
        completeness: collection.completeness,
        completenessNarrative:
          collection.completeness === null
            ? null
            : (COMPLETENESS_NARRATIVES[collection.completeness] ?? null),
        sources: collection.sources,
        startedAt: collection.startedAt?.toISOString() ?? null,
        finishedAt: collection.finishedAt?.toISOString() ?? null,
        progress,
        exceptionCounts,
        manifest:
          collection.manifestKey.length > 0
            ? {
                objectKey: collection.manifestKey,
                sha256: collection.manifestSha256,
                downloadAvailable: true,
              }
            : null,
      };
    });
  }

  async action(
    auth: AuthContext,
    id: string,
    actionRaw: string,
    request: FastifyRequest,
  ): Promise<{ id: string; status: string; retriedItems?: number }> {
    const parsed = collectionAction.safeParse(actionRaw);
    if (!parsed.success) throw new BadRequestException('unknown collection action');
    const action = parsed.data;

    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!collection) throw new NotFoundException();

      if (!LEGAL_TRANSITIONS[action].includes(collection.status)) {
        throw new ConflictException(
          `cannot ${action} a collection in status '${collection.status}'`,
        );
      }

      if (action === 'pause') {
        await tx.collection.update({
          where: { id },
          data: { status: CollectionStatus.paused, pausedAt: new Date() },
        });
        await this.appendActionAudit(tx, auth, id, 'collection.paused', {}, request);
        return { id, status: CollectionStatus.paused };
      }

      if (action === 'resume') {
        await tx.collection.update({
          where: { id },
          data: { status: CollectionStatus.fetching, pausedAt: null },
        });
        const resumeCount = await tx.outboxEvent.count({
          where: {
            tenantId: auth.tenantId,
            topic: 'collection.discover',
            dedupKey: { startsWith: `discover:${id}:resume:` },
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId: auth.tenantId,
            topic: 'collection.discover',
            dedupKey: `discover:${id}:resume:${resumeCount + 1}`,
            payload: { tenantId: auth.tenantId, collectionId: id },
          },
        });
        await this.appendActionAudit(tx, auth, id, 'collection.resumed', {}, request);
        return { id, status: CollectionStatus.fetching };
      }

      if (action === 'cancel') {
        // The worker observes 'cancelling' and finalizes as 'cancelled'.
        await tx.collection.update({
          where: { id },
          data: { status: CollectionStatus.cancelling, cancelledAt: new Date() },
        });
        await this.appendActionAudit(tx, auth, id, 'collection.cancelled', {}, request);
        return { id, status: CollectionStatus.cancelling };
      }

      // retry: re-enqueue failed items (one fetch-item job per item, capped).
      const failedItems = await tx.collectionItem.findMany({
        where: { tenantId: auth.tenantId, collectionId: id, state: CollectionItemState.failed },
        select: {
          id: true,
          custodianId: true,
          source: true,
          providerItemId: true,
          attempts: true,
        },
        orderBy: { id: 'asc' },
        take: RETRY_ITEM_CAP,
      });
      // Worker payload/dedup contract: item:{coll}:{cust}:{source}:{provId}
      // plus an :a{attempts} suffix so a retry round gets a fresh dedup key.
      for (const batch of chunk(failedItems, RETRY_BATCH_SIZE)) {
        await tx.outboxEvent.createMany({
          data: batch.map((item) => ({
            tenantId: auth.tenantId,
            topic: 'collection.fetch-item',
            dedupKey: `item:${id}:${item.custodianId}:${item.source}:${item.providerItemId}:a${item.attempts}`,
            payload: {
              tenantId: auth.tenantId,
              collectionId: id,
              custodianId: item.custodianId,
              source: item.source,
              providerItemId: item.providerItemId,
            },
          })),
          skipDuplicates: true,
        });
      }
      if (failedItems.length > 0) {
        await tx.collection.update({
          where: { id },
          data: { status: CollectionStatus.fetching, finishedAt: null },
        });
      }
      await this.appendActionAudit(
        tx,
        auth,
        id,
        'collection.retried',
        { retriedItems: failedItems.length },
        request,
      );
      return {
        id,
        status: failedItems.length > 0 ? CollectionStatus.fetching : collection.status,
        retriedItems: failedItems.length,
      };
    });
  }

  private async appendActionAudit(
    tx: Parameters<AuditService['appendTx']>[0],
    auth: AuthContext,
    collectionId: string,
    action: string,
    summary: Record<string, unknown>,
    request: FastifyRequest,
  ): Promise<void> {
    await this.audit.appendTx(tx, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorDisplay: auth.actorDisplay,
      effectiveRoles: auth.roles,
      action,
      targetType: 'collection',
      targetId: collectionId,
      summary,
      request,
    });
  }
}
