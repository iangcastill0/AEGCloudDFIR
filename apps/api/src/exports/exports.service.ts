import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ExportStatus,
  Prisma,
  withTenantContext,
  type PrismaClient,
} from '@aeg-clouddfir/database';
import type { z } from 'zod';
import { createExportRequest } from '@aeg-clouddfir/contracts';
import { derivativeKey, type EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { AuditService } from '../audit/audit.service.js';
import { SelectionService } from '../search/selection.service.js';

type CreateExportRequest = z.infer<typeof createExportRequest>;

/** Statuses that count against the concurrent-exports quota. */
const ACTIVE_STATUSES: ExportStatus[] = [
  ExportStatus.queued,
  ExportStatus.running,
  ExportStatus.verifying,
];

/** create() returns the full export plus whether this replayed an existing one. */
export type CreateExportResult = ExportDto & { replayed: boolean };

export interface ExportDto {
  id: string;
  kind: string;
  name: string;
  status: string;
  statusDetail: string;
  itemCount: number;
  totalBytes: string;
  verifiedAt: string | null;
  downloadExpiresAt: string | null;
}

type ExportRow = {
  id: string;
  kind: string;
  name: string;
  status: ExportStatus;
  statusDetail: string;
  itemCount: number;
  totalBytes: bigint;
  verifiedAt: Date | null;
  expiresAt: Date | null;
};

/** Single source of truth for the columns toDto needs. */
const EXPORT_SELECT = {
  id: true,
  kind: true,
  name: true,
  status: true,
  statusDetail: true,
  itemCount: true,
  totalBytes: true,
  verifiedAt: true,
  expiresAt: true,
} as const;

function toDto(row: ExportRow): ExportDto {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    statusDetail: row.statusDetail,
    itemCount: row.itemCount,
    totalBytes: row.totalBytes.toString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    downloadExpiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

@Injectable()
export class ExportsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    private readonly audit: AuditService,
    private readonly selection: SelectionService,
  ) {}

  /** Cheap selection count — never loads item rows. */
  private async countSelection(auth: AuthContext, input: CreateExportRequest): Promise<number> {
    const selection = input.selection;
    if (selection.kind === 'saved_search') {
      return this.selection.countForSavedSearch(auth.tenantId, selection.savedSearchId);
    }
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      switch (selection.kind) {
        case 'items':
          return tx.evidenceItem.count({
            where: { tenantId: auth.tenantId, id: { in: selection.evidenceItemIds } },
          });
        case 'tag': {
          const tag = await tx.tag.findFirst({
            where: { id: selection.tagId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!tag) throw new NotFoundException();
          return tx.tagAssignment.count({ where: { tenantId: auth.tenantId, tagId: tag.id } });
        }
        case 'case': {
          const found = await tx.case.findFirst({
            where: { id: selection.caseId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!found) throw new NotFoundException();
          return tx.caseItem.count({
            where: { tenantId: auth.tenantId, caseId: selection.caseId },
          });
        }
        default:
          return 0;
      }
    });
  }

  async create(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
    // Returns the FULL export, not a partial. The web client validates this
    // response with the same schema it uses for GET, so a narrower shape fails
    // Zod with six "expected string, received undefined" errors and the export
    // never appears — even though it was created successfully.
  ): Promise<CreateExportResult> {
    const input = zodValidate(createExportRequest, body);

    // The saved-search count above may hit the search engine; do it before
    // opening the transaction.
    const itemCount = await this.countSelection(auth, input);

    try {
      return await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        const existing = await tx.export.findFirst({
          where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
          select: EXPORT_SELECT,
        });
        if (existing) {
          return { ...toDto(existing), replayed: true };
        }

        if (input.caseId !== undefined) {
          const found = await tx.case.findFirst({
            where: { id: input.caseId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!found) throw new NotFoundException();
        }

        const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
        if (!tenant) throw new NotFoundException();
        const active = await tx.export.count({
          where: { tenantId: auth.tenantId, status: { in: ACTIVE_STATUSES } },
        });
        assertWithinQuota(
          'maxConcurrentExports',
          active,
          readQuota(tenant, 'maxConcurrentExports'),
        );

        // Frozen parameters: EXACTLY the worker contract subset.
        const parameters = {
          selection: input.selection,
          includeFamilies: input.includeFamilies,
          ...(input.csv !== undefined ? { csv: input.csv } : {}),
          archiveSplitMb: input.archiveSplitMb,
        };

        const exportRow = await tx.export.create({
          data: {
            tenantId: auth.tenantId,
            caseId: input.caseId ?? null,
            kind: input.kind,
            name: input.name,
            parameters: parameters as Prisma.InputJsonValue,
            status: ExportStatus.queued,
            idempotencyKey: input.idempotencyKey,
            itemCount,
            createdById: auth.userId,
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId: auth.tenantId,
            topic: 'export.run',
            dedupKey: `export:${exportRow.id}`,
            payload: { tenantId: auth.tenantId, exportId: exportRow.id },
          },
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'export.created',
          targetType: 'export',
          targetId: exportRow.id,
          summary: {
            kind: input.kind,
            name: input.name,
            selectionKind: input.selection.kind,
            itemCount,
          },
          request,
        });
        return { ...toDto(exportRow), replayed: false };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
          tx.export.findFirst({
            where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
            select: EXPORT_SELECT,
          }),
        );
        if (existing) {
          return { ...toDto(existing), replayed: true };
        }
      }
      throw err;
    }
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: ExportDto[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.export.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const slice = rows.slice(0, page.limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map(toDto),
      nextCursor: rows.length > page.limit && last ? last.id : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<ExportDto> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.export.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!row) throw new NotFoundException();
    return toDto(row);
  }

  /** Highest archive part number, read from the stored manifest (fallback 1). */
  private async archivePartCount(tenantId: string, manifestKey: string): Promise<number> {
    try {
      const stream = await this.store.getStream('evidence', manifestKey);
      const chunks: Buffer[] = [];
      for await (const piece of stream) {
        chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array));
      }
      const manifest: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof manifest !== 'object' || manifest === null) return 1;
      const items = (manifest as Record<string, unknown>).items;
      if (!Array.isArray(items)) return 1;
      let max = 1;
      for (const entry of items) {
        if (typeof entry === 'object' && entry !== null) {
          const part = (entry as Record<string, unknown>).archivePart;
          if (typeof part === 'number' && part > max) max = part;
        }
      }
      return max;
    } catch {
      return 1;
    }
  }

  async download(
    auth: AuthContext,
    id: string,
    request: FastifyRequest,
  ): Promise<{
    manifestUrl: string;
    archiveUrls: string[];
    manifestSha256: string;
    expiresInSeconds: number;
  }> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.export.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!row) throw new NotFoundException();
    if (row.status !== ExportStatus.ready) {
      throw new ConflictException(`export is not ready (status: ${row.status})`);
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) {
      throw new GoneException('this export has expired and its download window is closed');
    }

    // Key layout is the worker's putDerivative convention.
    const manifestKey = derivativeKey(auth.tenantId, id, 'export-manifest', 1, 'manifest.json');
    const parts = await this.archivePartCount(auth.tenantId, manifestKey);
    const archiveKeys = Array.from({ length: parts }, (_, i) =>
      derivativeKey(
        auth.tenantId,
        id,
        'archive',
        i + 1,
        `export-part${String(i + 1).padStart(3, '0')}.zip`,
      ),
    );

    const ttlSeconds = this.config.CDFIR_S3_PRESIGN_TTL_SECONDS;
    // Sign the disposition in: without it the browser renders manifest.json as
    // text instead of saving it, and the HTML download attribute is ignored
    // cross-origin.
    const manifestUrl = await this.store.presignGet(auth.tenantId, manifestKey, {
      ttlSeconds,
      downloadFilename: `export-${id}-manifest.json`,
    });
    const archiveUrls = await Promise.all(
      archiveKeys.map((key, i) =>
        this.store.presignGet(auth.tenantId, key, {
          ttlSeconds,
          downloadFilename: `export-${id}-part${String(i + 1).padStart(3, '0')}.zip`,
        }),
      ),
    );

    // Audit the download; presigned URLs are never logged or audited.
    await this.audit.append({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorDisplay: auth.actorDisplay,
      effectiveRoles: auth.roles,
      action: 'export.downloaded',
      targetType: 'export',
      targetId: id,
      summary: { name: row.name, kind: row.kind, archiveParts: parts },
      request,
    });

    return {
      manifestUrl,
      archiveUrls,
      manifestSha256: row.manifestSha256,
      expiresInSeconds: ttlSeconds,
    };
  }
}
