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
import {
  archivePartFilename,
  derivativeKey,
  derivativeTypeFor,
  type EvidenceObjectStore,
} from '@aeg-clouddfir/evidence';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { AuditService } from '../audit/audit.service.js';
import { importReadableEvidenceWhere } from '../imports/import-access.js';
import { SelectionService } from '../search/selection.service.js';
import { chunk, FAMILY_QUERY_CHUNK } from '../common/families.js';
import { signDownloadToken, verifyDownloadToken } from './download-token.js';

type CreateExportRequest = z.infer<typeof createExportRequest>;

/** Statuses that count against the concurrent-exports quota. */
const ACTIVE_STATUSES: ExportStatus[] = [
  ExportStatus.queued,
  ExportStatus.running,
  ExportStatus.verifying,
];

/** create() returns the full export plus whether this replayed an existing one. */
export type CreateExportResult = ExportDto & { replayed: boolean };

/**
 * One archive part, ready for a client to save into a folder.
 *
 * `sha256` and `sizeBytes` are null for exports produced before part digests
 * were recorded. Null means "cannot verify" and must be shown that way, never
 * folded into a silent success.
 */
export interface ExportDownloadPart {
  partNumber: number;
  filename: string;
  sizeBytes: number | null;
  sha256: string | null;
  url: string;
}

export interface ExportDownloadResult {
  manifestUrl: string;
  /** Legacy shape, kept so an older client keeps working. Same URLs as `parts`. */
  archiveUrls: string[];
  manifestSha256: string;
  expiresInSeconds: number;
  parts: ExportDownloadPart[];
  folderName: string;
  downloadToken: string;
  downloadTokenExpiresInSeconds: number;
}

export interface ExportDownloadRefreshResult {
  manifestUrl: string;
  parts: ExportDownloadPart[];
  expiresInSeconds: number;
}

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
      const importFence = importReadableEvidenceWhere(auth);
      switch (selection.kind) {
        case 'items': {
          // createExportRequest puts no ceiling on this list, unlike the case
          // and tag requests which cap at 10,000. One bind variable per id and
          // Prisma refuses past 32,767, so an unchunked count is a 500 waiting
          // for a big enough export. Same fault already hit enqueueReindex.
          let total = 0;
          for (const batch of chunk(selection.evidenceItemIds, FAMILY_QUERY_CHUNK)) {
            total += await tx.evidenceItem.count({
              where: { tenantId: auth.tenantId, id: { in: batch }, ...importFence },
            });
          }
          return total;
        }
        case 'tag': {
          const tag = await tx.tag.findFirst({
            where: { id: selection.tagId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!tag) throw new NotFoundException();
          return tx.tagAssignment.count({
            where: { tenantId: auth.tenantId, tagId: tag.id, evidenceItem: importFence },
          });
        }
        case 'case': {
          const found = await tx.case.findFirst({
            where: { id: selection.caseId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!found) throw new NotFoundException();
          return tx.caseItem.count({
            where: {
              tenantId: auth.tenantId,
              caseId: selection.caseId,
              evidenceItem: importFence,
            },
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
          attachments: input.attachments,
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

  /**
   * The parts of an export, with a digest each where one was recorded.
   *
   * Two sources, in order of trust. `export_parts` is authoritative and is
   * written in the same transaction that marks an export ready. Exports made
   * before that existed have no rows, so the count still falls back to the
   * manifest and every digest comes back null — "cannot verify", which a
   * client must show as such rather than implying the part checked out.
   */
  private async resolveParts(
    tenantId: string,
    exportId: string,
    kind: string,
  ): Promise<
    { partNumber: number; objectKey: string; sha256: string | null; sizeBytes: number | null }[]
  > {
    const recorded = await withTenantContext(this.prisma, tenantId, (tx) =>
      tx.exportPart.findMany({
        where: { exportId, tenantId },
        orderBy: { partNumber: 'asc' },
        select: { partNumber: true, objectKey: true, sha256: true, sizeBytes: true },
      }),
    );
    if (recorded.length > 0) {
      return recorded.map((p) => ({
        partNumber: p.partNumber,
        objectKey: p.objectKey,
        sha256: p.sha256,
        sizeBytes: Number(p.sizeBytes),
      }));
    }

    const manifestKey = derivativeKey(tenantId, exportId, 'export-manifest', 1, 'manifest.json');
    const count = await this.archivePartCount(tenantId, manifestKey);
    return Array.from({ length: count }, (_, i) => ({
      partNumber: i + 1,
      objectKey: derivativeKey(
        tenantId,
        exportId,
        derivativeTypeFor(kind),
        i + 1,
        archivePartFilename(kind, i + 1),
      ),
      sha256: null,
      sizeBytes: null,
    }));
  }

  /**
   * Presign every part and the manifest.
   *
   * Filenames are part of the contract, not cosmetics: they are what a client
   * writes into the download folder, so they must sort in part order and be
   * identical whichever endpoint issued them. The disposition is signed into
   * the URL because the HTML `download` attribute is ignored cross-origin, and
   * without it a browser renders manifest.json as text instead of saving it.
   */
  private async presignBundle(
    tenantId: string,
    exportId: string,
    kind: string,
    parts: {
      partNumber: number;
      objectKey: string;
      sha256: string | null;
      sizeBytes: number | null;
    }[],
  ): Promise<{ manifestUrl: string; signed: ExportDownloadPart[]; ttlSeconds: number }> {
    const ttlSeconds = this.config.CDFIR_S3_PRESIGN_TTL_SECONDS;
    const manifestKey = derivativeKey(tenantId, exportId, 'export-manifest', 1, 'manifest.json');
    const manifestUrl = await this.store.presignGet(tenantId, manifestKey, {
      ttlSeconds,
      downloadFilename: 'manifest.json',
    });
    const signed = await Promise.all(
      parts.map(async (part) => {
        const filename = archivePartFilename(kind, part.partNumber);
        return {
          partNumber: part.partNumber,
          filename,
          sizeBytes: part.sizeBytes,
          sha256: part.sha256,
          url: await this.store.presignGet(tenantId, part.objectKey, {
            ttlSeconds,
            downloadFilename: filename,
          }),
        };
      }),
    );
    return { manifestUrl, signed, ttlSeconds };
  }

  /** Load a ready, unexpired export or throw the right error for why not. */
  private async loadDownloadable(
    tenantId: string,
    id: string,
  ): Promise<{ name: string; kind: string; manifestSha256: string }> {
    const row = await withTenantContext(this.prisma, tenantId, (tx) =>
      tx.export.findFirst({ where: { id, tenantId } }),
    );
    if (!row) throw new NotFoundException();
    if (row.status !== ExportStatus.ready) {
      throw new ConflictException(`export is not ready (status: ${row.status})`);
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) {
      throw new GoneException('this export has expired and its download window is closed');
    }
    return { name: row.name, kind: row.kind, manifestSha256: row.manifestSha256 };
  }

  async download(
    auth: AuthContext,
    id: string,
    request: FastifyRequest,
  ): Promise<ExportDownloadResult> {
    const row = await this.loadDownloadable(auth.tenantId, id);
    const parts = await this.resolveParts(auth.tenantId, id, row.kind);
    const { manifestUrl, signed, ttlSeconds } = await this.presignBundle(
      auth.tenantId,
      id,
      row.kind,
      parts,
    );

    const tokenTtl = this.config.CDFIR_EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS;
    const downloadToken = signDownloadToken(
      this.config.CDFIR_SESSION_SECRET,
      { tenantId: auth.tenantId, exportId: id, userId: auth.userId },
      tokenTtl,
    );

    // Audit the download; presigned URLs and the token are never logged.
    await this.audit.append({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorDisplay: auth.actorDisplay,
      effectiveRoles: auth.roles,
      action: 'export.downloaded',
      targetType: 'export',
      targetId: id,
      summary: {
        name: row.name,
        kind: row.kind,
        archiveParts: parts.length,
        verifiable: parts.every((p) => p.sha256 !== null),
      },
      request,
    });

    return {
      manifestUrl,
      // Kept alongside `parts` so an older client keeps working unchanged.
      archiveUrls: signed.map((p) => p.url),
      manifestSha256: row.manifestSha256,
      expiresInSeconds: ttlSeconds,
      parts: signed,
      folderName: downloadFolderName(row.name, id),
      downloadToken,
      downloadTokenExpiresInSeconds: tokenTtl,
    };
  }

  /**
   * Re-sign for a script that is already partway through, authenticated by the
   * scoped token rather than a session.
   *
   * Every call is audited. A 65-part download refreshing as it goes will write
   * several rows, and that is the intended record: each one handed out fresh
   * reach to evidence, and the audit log is what says so.
   */
  async refreshDownloadUrls(
    token: string,
    id: string,
    request: FastifyRequest,
  ): Promise<ExportDownloadRefreshResult> {
    const claims = verifyDownloadToken(this.config.CDFIR_SESSION_SECRET, token);
    // A token for a DIFFERENT export is as unauthorised as no token at all.
    if (claims === null || claims.exportId !== id) throw new NotFoundException();

    // Re-checked on every refresh, not just at issue: a token cannot be
    // revoked, so the export's own expiry is what retires a long download.
    const row = await this.loadDownloadable(claims.tenantId, id);
    const parts = await this.resolveParts(claims.tenantId, id, row.kind);
    const { manifestUrl, signed, ttlSeconds } = await this.presignBundle(
      claims.tenantId,
      id,
      row.kind,
      parts,
    );

    await this.audit.append({
      tenantId: claims.tenantId,
      actorUserId: claims.userId,
      actorDisplay: 'export download token',
      effectiveRoles: [],
      action: 'export.downloaded',
      targetType: 'export',
      targetId: id,
      summary: { name: row.name, kind: row.kind, archiveParts: parts.length, viaToken: true },
      request,
    });

    return { manifestUrl, parts: signed, expiresInSeconds: ttlSeconds };
  }
}

/**
 * A folder name a filesystem will accept, on every OS, that still says which
 * export it is.
 *
 * The id suffix is not decoration: two exports of the same case are routinely
 * given the same name, and silently merging them into one folder would mix two
 * evidence sets together.
 */
export function downloadFolderName(name: string, exportId: string): string {
  // Letters, numbers, dot, underscore, hyphen only. Anything else — including
  // $() and backticks — would run when a download script assigns this name.
  const safe = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  const stem = safe === '' ? 'export' : safe;
  const suffix = exportId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `${stem}-${suffix === '' ? 'export' : suffix}`;
}
