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
  ProcessingStatus,
  ConnectorStatus,
  Prisma,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import { z } from 'zod';
import {
  collectionAction,
  createCollectionRequestFields,
  type CollectionItemStateCounts,
  type CollectionStatusResponse,
  type CollectionThroughputResponse,
} from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, queryInChunks, FAMILY_QUERY_CHUNK } from '../common/families.js';
import { autoCaseDescription, autoCaseName } from './auto-case.js';
import {
  EMPTY_PACE,
  completeBuckets,
  computePace,
  decideState,
  fillBuckets,
  historyBucketMinutes,
  isDiscovering,
  isMeasuring,
  phaseProgress,
  windowName,
  type RawBucket,
} from './throughput.js';
import { AuditService } from '../audit/audit.service.js';
import type { AppConfig } from '@aeg-clouddfir/config';
import { derivativeKey, type EvidenceObjectStore } from '@aeg-clouddfir/evidence';

/** Statuses that count against the concurrent-collections quota. */
const ACTIVE_STATUSES: CollectionStatus[] = [
  CollectionStatus.created,
  CollectionStatus.discovering,
  CollectionStatus.fetching,
  CollectionStatus.processing,
  CollectionStatus.finalizing,
];

/**
 * API-level create schema, built from the contract's field shape (the refined
 * contract schema cannot be extended). Relaxations relative to the contract:
 * audit-log collections are organization-scoped and select no custodians, so
 * custodianIds may be empty when only the audit source is present. Upload
 * collections follow the contract rules: email-only, connectorAccountId
 * resolved server-side, exactly one of custodianIds / uploadCustodian.
 */
const createCollectionApiSchema = createCollectionRequestFields
  .extend({ custodianIds: z.array(z.string().uuid()).max(10000) })
  .superRefine((value, ctx) => {
    const isUpload = value.scope.uploads !== undefined;
    if (isUpload) {
      if (value.sources.length !== 1 || value.sources[0] !== 'email') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources'],
          message: 'upload collections support only the email source',
        });
      }
      if (value.custodianIds.length > 0 === (value.uploadCustodian !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custodianIds'],
          message: 'upload collections require exactly one of custodianIds or uploadCustodian',
        });
      }
      return;
    }
    if (value.connectorAccountId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connectorAccountId'],
        message: 'connectorAccountId is required for provider collections',
      });
    }
    if (value.uploadCustodian !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uploadCustodian'],
        message: 'uploadCustodian applies only to upload collections (scope.uploads)',
      });
    }
    const needsCustodian = value.sources.some((s) => s !== 'audit');
    if (needsCustodian && value.custodianIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custodianIds'],
        message: 'email and drive collections require at least one custodian',
      });
    }
  });

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
/**
 * Re-indexing is capped far higher than re-fetching because it costs no
 * provider call — it re-reads bytes already on disk. A real failure ran to
 * 15,770 items, and a 1,000 cap would have meant sixteen rounds of clicking
 * with no way to tell which thousand you had already done.
 */
const RETRY_INDEX_CAP = 50_000;
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

/** How long the live throughput window looks back. */
const LIVE_WINDOW_MINUTES = 60;

/** Raw shapes of the two throughput reads. `bytes` is text: the column is BigInt. */
interface ThroughputBoundsRow {
  firstAt: Date | null;
  lastAt: Date | null;
  totalItems: number;
  totalBytes: string;
}
interface ThroughputBucketRow {
  startedAt: Date;
  items: number;
  bytes: string;
}

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
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Presigned URLs for a collection's manifest and completeness report.
   *
   * Returns an envelope rather than streaming the file: the response carries the
   * manifest's SHA-256 so a recipient can verify the bytes they fetched, and the
   * disposition is signed into the URL because a presigned URL points at the
   * storage host, where the browser would otherwise render the JSON inline.
   */
  async manifestDownload(
    auth: AuthContext,
    id: string,
    request: FastifyRequest,
  ): Promise<{
    manifestUrl: string;
    manifestSha256: string;
    completenessReportUrl: string | null;
    expiresInSeconds: number;
  }> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { id: true, manifestKey: true, manifestSha256: true, status: true },
      }),
    );
    if (!row) throw new NotFoundException();
    if (row.manifestKey === null || row.manifestKey === '') {
      // The manifest is written by the finalizer, so it does not exist until the
      // collection finishes. Saying so beats a 404 that looks like a lost record.
      throw new ConflictException(
        `this collection has no manifest yet (status: ${row.status}); it is written when the collection finalizes`,
      );
    }

    const ttlSeconds = this.config.CDFIR_S3_PRESIGN_TTL_SECONDS;
    const manifestUrl = await this.store.presignGet(auth.tenantId, row.manifestKey, {
      ttlSeconds,
      downloadFilename: `collection-${id}-manifest.json`,
    });

    // The completeness report is best-effort: older collections predate it, and
    // its absence must not block access to the manifest itself.
    let completenessReportUrl: string | null;
    try {
      completenessReportUrl = await this.store.presignGet(
        auth.tenantId,
        derivativeKey(auth.tenantId, id, 'completeness-report', 1, 'report.txt'),
        { ttlSeconds, downloadFilename: `collection-${id}-completeness.txt` },
      );
    } catch {
      completenessReportUrl = null;
    }

    await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        effectiveRoles: auth.roles,
        action: 'collection.manifest_downloaded',
        targetType: 'collection',
        targetId: id,
        summary: { manifestSha256: row.manifestSha256 },
        request,
      }),
    );

    return {
      manifestUrl,
      manifestSha256: row.manifestSha256 ?? '',
      completenessReportUrl,
      expiresInSeconds: ttlSeconds,
    };
  }

  async create(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ id: string; status: string; replayed: boolean; caseId: string | null }> {
    const input = zodValidate(createCollectionApiSchema, body);
    const includesAudit = input.sources.includes('audit');
    const uploadsScope = input.scope.uploads;

    try {
      const result = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        // Idempotent replay: same key returns the existing collection.
        const existing = await tx.collection.findFirst({
          where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
          select: { id: true, status: true, caseId: true },
        });
        if (existing) {
          return {
            id: existing.id,
            status: existing.status,
            replayed: true,
            caseId: existing.caseId,
          };
        }

        let connector: { id: string; mode: string };
        let custodianIds = input.custodianIds;
        if (uploadsScope !== undefined) {
          // Uploads live under one synthetic per-tenant connector, resolved
          // (or created) server-side — clients never manage it directly.
          connector = await this.resolveUploadConnector(tx, auth);
          if (input.uploadCustodian !== undefined) {
            const custodian = await tx.custodian.upsert({
              where: {
                connectorAccountId_externalId: {
                  connectorAccountId: connector.id,
                  externalId: input.uploadCustodian.email,
                },
              },
              create: {
                tenantId: auth.tenantId,
                connectorAccountId: connector.id,
                externalId: input.uploadCustodian.email,
                email: input.uploadCustodian.email,
                displayName: input.uploadCustodian.displayName,
              },
              update: { displayName: input.uploadCustodian.displayName },
              select: { id: true },
            });
            custodianIds = [custodian.id];
          }
          await this.assertUploadsClaimable(tx, auth, uploadsScope.evidenceItemIds);
        } else {
          if (input.connectorAccountId === undefined) {
            throw new BadRequestException('connectorAccountId is required');
          }
          const found = await tx.connectorAccount.findFirst({
            where: { id: input.connectorAccountId, tenantId: auth.tenantId },
          });
          if (!found) throw new NotFoundException();
          if (found.status !== ConnectorStatus.connected) {
            throw new ConflictException('connector is not connected');
          }
          // Audit logs are tenant/organization-wide (app permission / DWD); a
          // delegated connector cannot collect them.
          if (includesAudit && found.mode !== 'organization') {
            throw new ConflictException(
              'audit-log collection requires an organization-mode connector; delegated connectors cannot collect audit logs',
            );
          }
          connector = found;
        }

        if (custodianIds.length > 0) {
          const custodians = await tx.custodian.findMany({
            where: {
              id: { in: custodianIds },
              tenantId: auth.tenantId,
              connectorAccountId: connector.id,
            },
            select: { id: true },
          });
          if (custodians.length !== custodianIds.length) {
            throw new BadRequestException(
              'every custodianId must belong to the selected connector',
            );
          }
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

        // Every collection lands in a case. Either the one the request named,
        // or a new one carrying the collection's name — because a collection
        // with no case reads as finished while being unreviewable, and doing
        // it by hand is a step that gets forgotten silently.
        let caseId: string;
        let caseCreated = false;
        if (input.caseId !== undefined) {
          const existing = await tx.case.findFirst({
            where: { id: input.caseId, tenantId: auth.tenantId },
            select: { id: true, status: true },
          });
          if (!existing) throw new NotFoundException();
          if (existing.status !== 'open') {
            throw new ConflictException('cannot collect into a closed case');
          }
          caseId = existing.id;
        } else {
          const now = new Date();
          const createdCase = await tx.case.create({
            data: {
              tenantId: auth.tenantId,
              name: autoCaseName(input.name, now),
              description: autoCaseDescription(input.name),
              createdById: auth.userId,
            },
            select: { id: true },
          });
          caseId = createdCase.id;
          caseCreated = true;
        }

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
            caseId,
          },
        });
        if (caseCreated) {
          // Audited as its own event: a case appearing without anyone asking
          // for one needs a record of where it came from.
          await this.audit.appendTx(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            actorDisplay: auth.actorDisplay,
            effectiveRoles: auth.roles,
            action: 'case.created',
            targetType: 'case',
            targetId: caseId,
            summary: { createdFor: 'collection', collectionId: collection.id },
            request,
          });
        }
        if (custodianIds.length > 0) {
          await tx.collectionCustodian.createMany({
            data: custodianIds.map((custodianId) => ({
              tenantId: auth.tenantId,
              collectionId: collection.id,
              custodianId,
            })),
          });
        }
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
            custodianCount: custodianIds.length,
            caseId,
            caseCreated,
            ...(uploadsScope !== undefined
              ? { uploadedContainers: uploadsScope.evidenceItemIds.length }
              : {}),
          },
          request,
        });
        return { id: collection.id, status: collection.status, replayed: false, caseId };
      });
      return result;
    } catch (err) {
      // Unique(tenantId, idempotencyKey) race: return the winner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
          tx.collection.findFirst({
            where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
            select: { id: true, status: true, caseId: true },
          }),
        );
        if (existing) {
          return {
            id: existing.id,
            status: existing.status,
            replayed: true,
            caseId: existing.caseId,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Resolve (or lazily create) the tenant's synthetic 'upload' connector: the
   * anchor for uploaded-container custodians and collections. There is no
   * provider side — it exists so uploads flow through the same connector /
   * custodian / collection model as API sources.
   */
  private async resolveUploadConnector(
    tx: TenantScopedTx,
    auth: AuthContext,
  ): Promise<{ id: string; mode: string }> {
    const existing = await tx.connectorAccount.findFirst({
      where: { tenantId: auth.tenantId, provider: 'upload' },
      select: { id: true, mode: true },
    });
    if (existing) return existing;
    return tx.connectorAccount.create({
      data: {
        tenantId: auth.tenantId,
        provider: 'upload',
        mode: 'organization',
        label: 'File uploads',
        externalIdentity: 'uploaded files',
        status: ConnectorStatus.connected,
        createdById: auth.userId,
      },
      select: { id: true, mode: true },
    });
  }

  /**
   * Every scoped upload must be an existing, unclaimed uploaded container.
   * A container already claimed by another collection is a 409 — one
   * container belongs to exactly one collection.
   */
  private async assertUploadsClaimable(
    tx: TenantScopedTx,
    auth: AuthContext,
    evidenceItemIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(evidenceItemIds)];
    // Chunked: this list has no ceiling in the contract, and one bind variable
    // per id runs into Prisma's 32,767 limit on a large upload batch. Shapes are
    // inferred from the query rather than restated, so a schema change cannot
    // drift away from a hand-written annotation.
    const batches = await Promise.all(
      chunk(uniqueIds, FAMILY_QUERY_CHUNK).map((batch) =>
        tx.evidenceItem.findMany({
          where: { id: { in: batch }, tenantId: auth.tenantId },
          select: { id: true, kind: true, provider: true, collectionId: true },
        }),
      ),
    );
    const items = batches.flat();
    if (items.length !== uniqueIds.length) {
      throw new BadRequestException(
        'every uploads.evidenceItemIds entry must reference an existing uploaded file',
      );
    }
    for (const item of items) {
      if (item.kind !== 'container' || item.provider !== 'upload') {
        throw new BadRequestException(
          'uploads.evidenceItemIds must reference uploaded container files',
        );
      }
      if (item.collectionId !== null) {
        throw new ConflictException(
          'an uploaded container is already claimed by another collection',
        );
      }
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

  /** Row-level exceptions ledger for the detail page (counts live in status). */
  async exceptions(
    auth: AuthContext,
    id: string,
    opts: { cursor?: string; limit: number; kind?: string },
  ): Promise<{
    items: {
      id: string;
      kind: string;
      message: string;
      itemRef: string | null;
      /** Evidence item this exception is about, when it is known. */
      evidenceItemId: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      occurredAt: string;
    }[];
    nextCursor: string | null;
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!collection) throw new NotFoundException();

      const rows = await tx.collectionException.findMany({
        where: {
          tenantId: auth.tenantId,
          collectionId: id,
          ...(opts.kind ? { kind: opts.kind as never } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: opts.limit + 1,
        ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      });
      const page = rows.slice(0, opts.limit);
      return {
        items: page.map((row) => {
          // providerItemId is empty for anything extracted from a container, so
          // fall back to the detail the worker records. Older rows have neither,
          // and honestly report null rather than inventing a reference.
          const detail = (row.detail ?? {}) as {
            evidenceItemId?: unknown;
            name?: unknown;
            mimeType?: unknown;
            sizeBytes?: unknown;
          };
          const name = typeof detail.name === 'string' && detail.name !== '' ? detail.name : null;
          return {
            id: row.id,
            kind: row.kind,
            message: row.message,
            itemRef: row.providerItemId !== '' ? row.providerItemId : name,
            evidenceItemId:
              typeof detail.evidenceItemId === 'string' ? detail.evidenceItemId : null,
            mimeType:
              typeof detail.mimeType === 'string' && detail.mimeType !== ''
                ? detail.mimeType
                : null,
            sizeBytes: typeof detail.sizeBytes === 'number' ? detail.sizeBytes : null,
            occurredAt: row.occurredAt.toISOString(),
          };
        }),
        nextCursor: rows.length > opts.limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  async status(auth: AuthContext, id: string): Promise<CollectionStatusResponse> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: {
          custodians: { include: { custodian: true } },
          case: { select: { id: true, name: true } },
        },
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
        case:
          collection.case === null ? null : { id: collection.case.id, name: collection.case.name },
      };
    });
  }

  /**
   * Measured throughput for one collection. No forecast, ever — see
   * ./throughput.ts for the replay numbers that rule one out.
   *
   * Two window shapes:
   * - `live`: the last 60 minutes at one bucket per minute, for "what is
   *   happening right now".
   * - `history`: the whole acquisition span, downsampled server-side to about
   *   200 buckets. The real run had 3,948 minutes and a browser draws them on
   *   roughly 900 pixels, so sending every minute would be four points per pixel
   *   for no extra information.
   *
   * KNOWN, DELIBERATE FOLLOW-UP: there is no covering index for the rollup.
   * Measured on the 434,910-item collection it ran 350 ms cold and **225 ms
   * warm**, reading 237 MB, which is fine against the 5-second poll the browser
   * uses. An index on evidence_items (collectionId, acquiredAt) INCLUDE (size)
   * would cut it, but packages/database/prisma/schema.prisma already carries
   * three other features' uncommitted changes and a migration here would tangle
   * them. Add it in its own change.
   */
  async throughput(
    auth: AuthContext,
    id: string,
    opts: {
      window: 'live' | 'history';
      /**
       * What the caller's previous poll was told. The browser echoes this number
       * back untouched; the SERVER still decides whether throttling rose, so the
       * page and the API can never disagree about the state.
       */
      previousRateLimitWaitMs?: number;
      now?: Date;
    },
  ): Promise<CollectionThroughputResponse> {
    const now = opts.now ?? new Date();

    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { custodians: true },
      });
      if (!collection) throw new NotFoundException();

      // Bounds and totals in one pass, so the window can be sized and the
      // cumulative-bytes line can start from a true number rather than from the
      // first bucket the window happens to include.
      const bounds = await tx.$queryRaw<ThroughputBoundsRow[]>`
        SELECT MIN(e."acquiredAt")                AS "firstAt",
               MAX(e."acquiredAt")                AS "lastAt",
               COUNT(*)::int                      AS "totalItems",
               COALESCE(SUM(e."size"), 0)::text   AS "totalBytes"
          FROM evidence_items e
         WHERE e."tenantId"     = ${auth.tenantId}::uuid
           AND e."collectionId" = ${id}::uuid
      `;
      const firstAt = bounds[0]?.firstAt ?? null;
      const lastAt = bounds[0]?.lastAt ?? null;
      const totalItems = bounds[0]?.totalItems ?? 0;
      const totalBytes = Number(bounds[0]?.totalBytes ?? '0');

      const [grouped, openPageCheckpoints, exceptionCount] = await Promise.all([
        tx.collectionItem.groupBy({
          by: ['state'],
          where: { tenantId: auth.tenantId, collectionId: id },
          _count: { _all: true },
        }),
        // An open page cursor means the provider has pages this run has not
        // walked, so the denominator is still moving.
        tx.collectionCheckpoint.count({
          where: { tenantId: auth.tenantId, collectionId: id, cursorKind: 'page' },
        }),
        tx.collectionException.count({ where: { tenantId: auth.tenantId, collectionId: id } }),
      ]);

      const itemStates: CollectionItemStateCounts = {
        discovered: 0,
        fetching: 0,
        preserved: 0,
        processed: 0,
        indexed: 0,
        failed: 0,
        skipped: 0,
      };
      for (const row of grouped) {
        itemStates[row.state as keyof CollectionItemStateCounts] = row._count._all;
      }

      // Provider throttling, summed across every custodian and source. The
      // per-custodian counters are the only place it is recorded.
      let rateLimitWaitMs = 0;
      for (const cc of collection.custodians) {
        for (const source of collection.sources) {
          rateLimitWaitMs += readCounters(cc.progress, source).rateLimitWaitMs;
        }
      }

      const live = opts.window === 'live';
      const liveFromMs = now.getTime() - LIVE_WINDOW_MINUTES * 60_000;
      // The whole-run window spans acquisition only — first byte to last byte.
      // The processing tail has no acquisitions in it, so extending the chart to
      // the end of the run would squash 66 h of real work into 70% of the width
      // and draw 27 h of zeros. The tail is reported as its own phase instead.
      // A collection that has acquired nothing gets NO buckets, not 60 idle ones.
      // Sixty grey stripes on a collection that is one minute old reads as an
      // hour of failure; the honest answer is that there is nothing to draw yet.
      const from =
        firstAt === null
          ? null
          : live
            ? new Date(Math.max(firstAt.getTime(), liveFromMs))
            : firstAt;
      const to = live ? now : lastAt;
      const bucketMinutes = live
        ? 1
        : historyBucketMinutes(
            from === null || to === null ? 0 : (to.getTime() - from.getTime()) / 60_000,
          );

      let rawBuckets: RawBucket[] = [];
      if (from !== null && to !== null) {
        const widthSeconds = bucketMinutes * 60;
        // date_trunc cannot take a variable width, so the bucket start is
        // floored on the epoch. `size` is BigInt in the column and JSON has no
        // BigInt, so it comes back as text and is converted once, here.
        const rows = await tx.$queryRaw<ThroughputBucketRow[]>`
          SELECT to_timestamp(
                   floor(extract(epoch FROM e."acquiredAt") / ${widthSeconds}::double precision)
                   * ${widthSeconds}::double precision
                 )                                AS "startedAt",
                 COUNT(*)::int                    AS "items",
                 COALESCE(SUM(e."size"), 0)::text AS "bytes"
            FROM evidence_items e
           WHERE e."tenantId"     = ${auth.tenantId}::uuid
             AND e."collectionId" = ${id}::uuid
             AND e."acquiredAt"  >= ${from}
             AND e."acquiredAt"  <= ${to}
           GROUP BY 1
           ORDER BY 1
        `;
        rawBuckets = rows.map((row) => ({
          startedAt: row.startedAt,
          items: row.items,
          bytes: Number(row.bytes),
        }));
      }

      const windowBytes = rawBuckets.reduce((n, b) => n + b.bytes, 0);
      const buckets =
        from === null || to === null
          ? []
          : fillBuckets(rawBuckets, {
              from,
              to,
              bucketMinutes,
              // Everything preserved before this window still happened, so the
              // cumulative line must not restart at zero.
              bytesBefore: Math.max(totalBytes - windowBytes, 0),
            });

      const settled = completeBuckets(buckets, { now, bucketMinutes });
      const measuring = isMeasuring({ completeBucketCount: settled.length, items: totalItems });
      const pace = computePace(settled, { measuring, bucketMinutes });

      const decision = decideState({
        status: collection.status,
        now,
        lastAcquiredAt: lastAt,
        itemStates,
        openPageCheckpoints,
        exceptionCount,
        rateLimitWaitMs,
        previousRateLimitWaitMs: opts.previousRateLimitWaitMs ?? null,
        buckets: settled,
        bucketMinutes,
        totalItems,
      });

      const runStart = collection.startedAt ?? firstAt;
      const runEnd = collection.finishedAt ?? now;
      const runElapsedMs =
        runStart === null ? 0 : Math.max(runEnd.getTime() - runStart.getTime(), 0);
      const acquisitionElapsedMs =
        firstAt === null || lastAt === null ? 0 : Math.max(lastAt.getTime() - firstAt.getTime(), 0);

      const phases = phaseProgress({
        itemStates,
        denominatorMoving: isDiscovering({ status: collection.status, openPageCheckpoints }),
        acquisitionElapsedMs,
        runElapsedMs,
        acquisitionPace: pace,
        // The tail's pace is not measurable from acquiredAt: an item is
        // processed long after it was acquired, and nothing records when. Rather
        // than invent a number, the processing phase reports counts and elapsed
        // time only — all-null, which means "not measured", not "zero".
        processingPace: EMPTY_PACE,
      });

      return {
        collectionId: collection.id,
        status: collection.status,
        window: opts.window,
        windowName: windowName({
          window: opts.window,
          bucketMinutes,
          bucketCount: buckets.length,
        }),
        bucketMinutes,
        buckets,
        totals: {
          items: totalItems,
          bytes: totalBytes,
          firstAcquiredAt: firstAt?.toISOString() ?? null,
          lastAcquiredAt: lastAt?.toISOString() ?? null,
          acquisitionElapsedMs,
          runElapsedMs,
          idleBuckets: buckets.filter((b) => b.idle).length,
        },
        acquisition: phases.acquisition,
        processing: phases.processing,
        itemStates,
        state: decision.state,
        stateLabel: decision.stateLabel,
        health: decision.health,
        rateLimitWaitMs,
        exceptionCount,
      };
    });
  }

  async action(
    auth: AuthContext,
    id: string,
    actionRaw: string,
    request: FastifyRequest,
  ): Promise<{
    id: string;
    status: string;
    retriedItems?: number;
    retriedProcessing?: number;
  }> {
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

      // retry: re-enqueue failed items.
      //
      // Split by whether the bytes are already here. An item that HAS an
      // evidence item was collected, hashed and preserved — what failed came
      // later. Re-fetching it would download from the provider something we
      // already hold, byte-identical, and for a real failure of 15,770 items
      // that is hours of provider calls to replace nothing.
      //
      // Seen in production: an overloaded worker timed out on database
      // transactions inside the search-index stage, so 15,624 items were
      // marked failed with "search indexing failed". Every one of them still
      // had its bytes and its sha256. They needed re-indexing, not collecting.
      const allFailed = await tx.collectionItem.findMany({
        where: { tenantId: auth.tenantId, collectionId: id, state: CollectionItemState.failed },
        select: {
          id: true,
          custodianId: true,
          source: true,
          providerItemId: true,
          attempts: true,
          evidenceItemId: true,
        },
        orderBy: { id: 'asc' },
        take: RETRY_INDEX_CAP,
      });
      const hasEvidence = (item: { evidenceItemId: string | null }): boolean =>
        typeof item.evidenceItemId === 'string' && item.evidenceItemId !== '';
      const reindexable = allFailed.filter(
        (item): item is typeof item & { evidenceItemId: string } => hasEvidence(item),
      );
      // Only items with nothing preserved go back to the provider, and those
      // keep the original per-round cap: each one is a real API call.
      const failedItems = allFailed.filter((item) => !hasEvidence(item)).slice(0, RETRY_ITEM_CAP);
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
      // Re-index the ones that only failed to reach the search index. No
      // provider call: the bytes never left.
      let reindexed = 0;
      if (reindexable.length > 0) {
        const evidenceIds = reindexable.map((item) => item.evidenceItemId);
        const versions = await queryInChunks(evidenceIds, (batch) =>
          tx.evidenceItem.findMany({
            where: { tenantId: auth.tenantId, id: { in: batch } },
            select: { id: true, version: true },
          }),
        );
        const round = Date.now();
        for (const batch of chunk(versions, RETRY_BATCH_SIZE)) {
          await tx.outboxEvent.createMany({
            data: batch.map((item) => ({
              tenantId: auth.tenantId,
              topic: 'search.index',
              // A dedup key works once, ever, and these items were already
              // indexed once at this version — that attempt is what failed.
              // Without a fresh round marker the outbox drops every row and
              // the retry silently does nothing.
              dedupKey: `index:${item.id}:v${String(item.version)}:retry${String(round)}`,
              payload: { tenantId: auth.tenantId, evidenceItemId: item.id, version: item.version },
            })),
            skipDuplicates: true,
          });
        }
        // Back to 'preserved': the bytes ARE preserved and only indexing is
        // outstanding. Leaving them 'failed' would understate what was
        // collected, and finalize counts preserved as still in flight, so the
        // collection correctly waits for them rather than sealing short.
        for (const batch of chunk(
          reindexable.map((item) => item.id),
          RETRY_BATCH_SIZE,
        )) {
          const updated = await tx.collectionItem.updateMany({
            where: { id: { in: batch } },
            data: { state: CollectionItemState.preserved, lastError: '' },
          });
          reindexed += updated.count;
        }
      }

      // Processing exceptions are a DIFFERENT failure from a failed fetch: the
      // bytes were collected fine, but a later stage (text extraction, OCR)
      // could not read them. Retrying only fetch failures left these stuck
      // forever, which is what made the button appear to do nothing.
      const stuckItems = await tx.evidenceItem.findMany({
        where: {
          tenantId: auth.tenantId,
          collectionId: id,
          processingStatus: ProcessingStatus.exception,
        },
        select: { id: true, version: true },
        orderBy: { id: 'asc' },
        take: RETRY_ITEM_CAP,
      });

      for (const batch of chunk(stuckItems, RETRY_BATCH_SIZE)) {
        await tx.outboxEvent.createMany({
          data: batch.map((item) => ({
            tenantId: auth.tenantId,
            topic: 'process.extract',
            // A retry round needs a fresh dedup key, or the outbox would treat
            // it as the already-dispatched original and drop it silently.
            dedupKey: `extract:${item.id}:v${String(item.version)}:retry${String(Date.now())}`,
            payload: { tenantId: auth.tenantId, evidenceItemId: item.id, version: item.version },
          })),
          skipDuplicates: true,
        });
      }

      if (stuckItems.length > 0) {
        // Move them off 'exception' so the UI reflects that work is queued.
        // If extraction fails again the processor puts them straight back.
        await tx.evidenceItem.updateMany({
          where: { id: { in: stuckItems.map((i) => i.id) } },
          data: { processingStatus: ProcessingStatus.pending },
        });

        // Clear the ledger rows for exactly these items. The exceptions list is
        // the set of OUTSTANDING problems and feeds disclosure; leaving an entry
        // for an item that has since been read would misstate the collection.
        // The permanent record lives in the append-only audit chain below, which
        // records the retry and its count.
        const openRows = await tx.collectionException.findMany({
          where: { tenantId: auth.tenantId, collectionId: id },
          select: { id: true, detail: true },
        });
        const retried = new Set(stuckItems.map((i) => i.id));
        const toClear = openRows
          .filter((row) => {
            const d = (row.detail ?? {}) as { evidenceItemId?: unknown };
            return typeof d.evidenceItemId === 'string' && retried.has(d.evidenceItemId);
          })
          .map((row) => row.id);
        if (toClear.length > 0) {
          await tx.collectionException.deleteMany({ where: { id: { in: toClear } } });
        }
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
        {
          retriedItems: failedItems.length,
          retriedProcessing: stuckItems.length,
          retriedIndexing: reindexed,
        },
        request,
      );
      return {
        id,
        status: failedItems.length > 0 ? CollectionStatus.fetching : collection.status,
        retriedItems: failedItems.length,
        retriedProcessing: stuckItems.length,
        retriedIndexing: reindexed,
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
