import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  MalwareStatus,
  Prisma,
  ProductionStatus,
  RedactionStage,
  RelationshipKind,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import {
  createProductionRequest,
  productionParameters,
  submitProductionRequest,
  type ProductionParameters,
} from '@aeg-clouddfir/contracts';
import { ProductionArchiveWriter } from '@aeg-clouddfir/production';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, expandFamilies } from '../common/families.js';
import { AuditService } from '../audit/audit.service.js';
import type { AppConfig } from '@aeg-clouddfir/config';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import { SelectionService, SELECTION_ID_CAP } from '../search/selection.service.js';
import {
  FLAG_DEFINITIONS,
  validateProductionSet,
  type ProductionValidationItem,
  type ValidationFlag,
} from './production.validator.js';

/** Statuses that count against the concurrent-productions quota. */
const ACTIVE_STATUSES: ProductionStatus[] = [
  ProductionStatus.validating,
  ProductionStatus.submitted,
];

const QUERY_CHUNK = 5000;

const updateProductionSchema = z.object({
  parameters: z.unknown(),
  version: z.number().int().min(1),
});

/** Extensions the render pipeline can convert to images/PDF. */
const CONVERTIBLE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'rtf',
  'csv',
  'htm',
  'html',
  'eml',
  'msg',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'webp',
  'odt',
  'ods',
  'odp',
  'md',
]);

const ARCHIVE_EXTENSIONS = new Set(['zip', 'pst', 'mbox', 'tar', 'gz', '7z', 'rar']);

const FAMILY_REL_KINDS: RelationshipKind[] = [
  RelationshipKind.attachment,
  RelationshipKind.inline_attachment,
  RelationshipKind.family,
];

interface ValidationSnapshot {
  calculatedAt: string;
  itemCount: number;
  itemIdsHash: string;
  flags: {
    code: string;
    severity: string;
    overridable: boolean;
    requiresElevatedOverride: boolean;
    count: number;
  }[];
}

const validationSnapshotSchema = z.object({
  calculatedAt: z.string(),
  itemCount: z.number().int(),
  itemIdsHash: z.string(),
  flags: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      overridable: z.boolean(),
      requiresElevatedOverride: z.boolean(),
      count: z.number().int(),
    }),
  ),
});

export interface ProductionRunDto {
  id: string;
  runNumber: number;
  status: string;
  progress: Record<string, number>;
  batesStart: string;
  batesEnd: string;
  exceptionCounts: Record<string, number>;
  manifestSha256: string;
}

export interface ProductionDto {
  id: string;
  name: string;
  description: string;
  status: string;
  caseId: string | null;
  createdAt: string;
  version: number;
  draftParameters: unknown;
}

function idsHash(ids: readonly string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'), 'utf8')
    .digest('hex');
}

function formatBates(prefix: string, num: bigint, digits: number, suffix: string): string {
  return `${prefix}${num.toString().padStart(digits, '0')}${suffix}`;
}

/** Everything the archive route needs, resolved before any bytes are written. */
export interface RunArchivePlan {
  runId: string;
  runNumber: number;
  prefix: string;
  /** Single top-level folder inside the zip, so extracting yields a folder. */
  rootFolder: string;
  fileName: string;
  manifestSha256: string;
  objects: { key: string; size: number }[];
  totalBytes: number;
}

/** The slice of ProductionArchiveWriter this service depends on. */
interface ArchiveSink {
  append: (path: string, source: Readable) => void;
  finalize: () => Promise<{ entryCount: number }>;
}

/**
 * Reduce a production name to something safe in a filename, a
 * Content-Disposition header and a zip entry path.
 *
 * Diacritics are folded rather than dropped, so "Unicode" survives as itself
 * instead of collapsing to "nc"; anything else becomes a single dash.
 */
function slugifyProductionName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A name of only punctuation would otherwise produce a nameless file.
  return slug === '' ? 'production' : slug;
}

@Injectable()
export class ProductionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly selection: SelectionService,
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Presigned URLs for everything a production run produced.
   *
   * This is how a production set reaches opposing counsel, so it is guarded and
   * audited like the disclosure it is. The file list is enumerated from storage
   * rather than assumed: a run writes volumes, images, load files and manifests
   * whose names depend on the production profile, and inventing that list in the
   * API would silently omit files when a profile changes.
   */
  /**
   * Exceptions across every run of a production.
   *
   * Scoped to the production rather than a single run on purpose: a reviewer
   * asking "what went wrong producing this set" does not care which attempt
   * raised it, and scoping per-run would hide problems from an earlier run that
   * were never resolved.
   */
  async exceptions(
    auth: AuthContext,
    productionId: string,
    page: CursorQuery,
  ): Promise<{
    items: {
      id: string;
      kind: string;
      message: string;
      itemRef: string | null;
      evidenceItemId: string | null;
      severity: string;
      overridden: boolean;
      occurredAt: string;
    }[];
    nextCursor: string | null;
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const production = await tx.production.findFirst({
        where: { id: productionId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!production) throw new NotFoundException();

      const runs = await tx.productionRun.findMany({
        where: { tenantId: auth.tenantId, productionId },
        select: { id: true },
      });
      if (runs.length === 0) return { items: [], nextCursor: null };

      const rows = await tx.productionException.findMany({
        where: {
          tenantId: auth.tenantId,
          productionRunId: { in: runs.map((r) => r.id) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...(page.cursor ? { skip: 1, cursor: { id: page.cursor } } : {}),
      });
      const items = rows.slice(0, page.limit);
      return {
        // Shape matches the shared exceptionEntry contract, because the client
        // renders collection and production exceptions through the same table.
        items: items.map((row) => ({
          id: row.id,
          kind: row.code,
          message: row.message,
          itemRef: row.evidenceItemId,
          evidenceItemId: row.evidenceItemId,
          severity: row.severity,
          // An overridden exception was consciously accepted; a reviewer needs to
          // see that it was waived rather than resolved.
          overridden: row.overriddenAt !== null,
          occurredAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length > page.limit ? (items[items.length - 1]?.id ?? null) : null,
      };
    });
  }

  async downloadRun(
    auth: AuthContext,
    productionId: string,
    runId: string,
    request: FastifyRequest,
  ): Promise<{
    files: { path: string; url: string; sizeBytes: number }[];
    manifestSha256: string;
    expiresInSeconds: number;
  }> {
    const run = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.productionRun.findFirst({
        where: { id: runId, productionId, tenantId: auth.tenantId },
        select: {
          id: true,
          status: true,
          outputPrefix: true,
          manifestSha256: true,
          runNumber: true,
        },
      }),
    );
    if (!run) throw new NotFoundException();

    // Only a finished run may be downloaded. Handing out a partially written
    // set would be worse than refusing: the recipient cannot tell it is partial.
    if (run.status !== 'ready' && run.status !== 'released') {
      throw new ConflictException(`production run is not downloadable (status: ${run.status})`);
    }
    if (run.outputPrefix === '') {
      throw new ConflictException('this run recorded no output location');
    }

    const objects = await this.store.listUnder('evidence', `${run.outputPrefix}/`);
    if (objects.length === 0) {
      // The row says ready but storage is empty — report it rather than hand
      // back an empty set that looks like a legitimately empty production.
      throw new ConflictException(
        'no files were found for this run; its output may have been removed by retention',
      );
    }

    const ttlSeconds = this.config.CDFIR_S3_PRESIGN_TTL_SECONDS;
    const files = await Promise.all(
      objects.map(async (o) => {
        const path = o.key.slice(run.outputPrefix.length + 1);
        return {
          path,
          sizeBytes: o.size,
          url: await this.store.presignGet(auth.tenantId, o.key, {
            ttlSeconds,
            downloadFilename: `production-run${String(run.runNumber)}-${path.replace(/\//g, '-')}`,
          }),
        };
      }),
    );

    await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        effectiveRoles: auth.roles,
        action: 'production.run_downloaded',
        targetType: 'production_run',
        targetId: runId,
        summary: {
          productionId,
          runNumber: run.runNumber,
          fileCount: files.length,
          manifestSha256: run.manifestSha256,
        },
        request,
      }),
    );

    return { files, manifestSha256: run.manifestSha256, expiresInSeconds: ttlSeconds };
  }

  /**
   * Resolve a run into an archive plan without writing anything.
   *
   * Split from the streaming half deliberately: everything that can legitimately
   * fail — wrong tenant, unfinished run, output swept by retention — must fail
   * while a JSON error can still be returned. Once the zip body has started, the
   * only way to signal a problem is to break the stream.
   */
  async prepareRunArchive(
    auth: AuthContext,
    productionId: string,
    runId: string,
  ): Promise<RunArchivePlan> {
    const run = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.productionRun.findFirst({
        where: { id: runId, productionId, tenantId: auth.tenantId },
        select: {
          id: true,
          status: true,
          outputPrefix: true,
          manifestSha256: true,
          runNumber: true,
          production: { select: { name: true } },
        },
      }),
    );
    if (!run) throw new NotFoundException();

    if (run.status !== 'ready' && run.status !== 'released') {
      throw new ConflictException(`production run is not downloadable (status: ${run.status})`);
    }
    if (run.outputPrefix === '') {
      throw new ConflictException('this run recorded no output location');
    }

    const objects = await this.store.listUnder('evidence', `${run.outputPrefix}/`);
    if (objects.length === 0) {
      throw new ConflictException(
        'no files were found for this run; its output may have been removed by retention',
      );
    }

    const rootFolder = `${slugifyProductionName(run.production.name)}-run${String(run.runNumber)}`;
    return {
      runId: run.id,
      runNumber: run.runNumber,
      prefix: run.outputPrefix,
      rootFolder,
      fileName: `${rootFolder}.zip`,
      manifestSha256: run.manifestSha256,
      objects: objects.map((o) => ({ key: o.key, size: o.size })),
      totalBytes: objects.reduce((sum, o) => sum + o.size, 0),
    };
  }

  /**
   * Stream the run's output as one ZIP64 archive under a single folder.
   *
   * The per-file endpoint above returns a presigned URL per object, which meant
   * downloading a production one click at a time and rebuilding DATA/IMAGES/
   * NATIVES/TEXT by hand. Entries here keep their path relative to the run
   * prefix beneath `rootFolder`, so extracting reproduces the volume layout.
   *
   * Sources open lazily: awaiting every GetObject up front would hold one
   * connection per file open for the life of the archive — thousands on a real
   * production, nearly all of them idle long enough to time out.
   */
  async streamRunArchive(
    auth: AuthContext,
    plan: RunArchivePlan,
    output: NodeJS.WritableStream,
    request: FastifyRequest,
    deps: { createArchive?: (out: NodeJS.WritableStream) => ArchiveSink } = {},
  ): Promise<{ entryCount: number }> {
    const archive = (deps.createArchive ?? ((out) => new ProductionArchiveWriter(out)))(output);

    for (const object of plan.objects) {
      const relative = object.key.slice(plan.prefix.length + 1);
      const key = object.key;
      archive.append(
        `${plan.rootFolder}/${relative}`,
        Readable.from(
          (async function* (store: EvidenceObjectStore) {
            yield* await store.getStream('evidence', key);
          })(this.store),
        ),
      );
    }

    // A read failure surfaces here and finalize rejects, so the central
    // directory is never written: the recipient gets a file unzip refuses,
    // not a valid archive quietly missing documents.
    const { entryCount } = await archive.finalize();

    await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        effectiveRoles: auth.roles,
        action: 'production.run_downloaded',
        targetType: 'production_run',
        targetId: plan.runId,
        summary: {
          productionId: plan.runId,
          runNumber: plan.runNumber,
          fileCount: entryCount,
          totalBytes: plan.totalBytes,
          manifestSha256: plan.manifestSha256,
          format: 'zip',
        },
        request,
      }),
    );

    return { entryCount };
  }

  // -------------------------------------------------------------------------
  // Draft lifecycle
  // -------------------------------------------------------------------------

  async create(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ id: string; status: string; replayed: boolean }> {
    const input = zodValidate(createProductionRequest, body);
    try {
      return await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        const existing = await tx.production.findFirst({
          where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
          select: { id: true, status: true },
        });
        if (existing) return { id: existing.id, status: existing.status, replayed: true };

        if (input.caseId !== undefined) {
          const found = await tx.case.findFirst({
            where: { id: input.caseId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!found) throw new NotFoundException();
        }

        const tenant = await tx.tenant.findUnique({ where: { id: auth.tenantId } });
        if (!tenant) throw new NotFoundException();
        const active = await tx.production.count({
          where: { tenantId: auth.tenantId, status: { in: ACTIVE_STATUSES } },
        });
        assertWithinQuota(
          'maxConcurrentProductions',
          active,
          readQuota(tenant, 'maxConcurrentProductions'),
        );

        const created = await tx.production.create({
          data: {
            tenantId: auth.tenantId,
            caseId: input.caseId ?? null,
            name: input.parameters.name,
            description: input.parameters.description,
            status: ProductionStatus.draft,
            draftParameters: input.parameters as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            createdById: auth.userId,
          },
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'production.created',
          targetType: 'production',
          targetId: created.id,
          summary: { name: input.parameters.name, outputMode: input.parameters.output.mode },
          request,
        });
        return { id: created.id, status: created.status, replayed: false };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
          tx.production.findFirst({
            where: { tenantId: auth.tenantId, idempotencyKey: input.idempotencyKey },
            select: { id: true, status: true },
          }),
        );
        if (existing) return { id: existing.id, status: existing.status, replayed: true };
      }
      throw err;
    }
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<ProductionDto> {
    const outer = zodValidate(updateProductionSchema, body);
    const parameters = zodValidate(productionParameters, outer.parameters);
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const production = await tx.production.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!production) throw new NotFoundException();
      if (production.status !== ProductionStatus.draft) {
        throw new ConflictException('only draft productions can be edited');
      }
      // Editing invalidates any prior validation snapshot (parameters changed).
      const updated = await tx.production.updateMany({
        where: { id, tenantId: auth.tenantId, version: outer.version },
        data: {
          name: parameters.name,
          description: parameters.description,
          draftParameters: parameters as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('production was modified concurrently; reload and retry');
      }
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'production.updated',
        targetType: 'production',
        targetId: id,
        summary: { name: parameters.name },
        request,
      });
      return tx.production.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
    });
    return this.toDto(row);
  }

  /**
   * Map a run row plus its exception tally to the client's run shape.
   *
   * Shared by get() and getRun(): the detail page validates both with the same
   * productionRunStatusResponse, and get() previously returned only
   * id/runNumber/status — six fields short — so the whole page failed to parse.
   */
  private static toRunDto(
    run: {
      id: string;
      runNumber: number;
      status: string;
      progress: unknown;
      batesStart: string;
      batesEnd: string;
      manifestSha256: string;
    },
    exceptionCounts: Record<string, number>,
  ): ProductionRunDto {
    const progress: Record<string, number> = {};
    // progress is JSONB, so it may be any shape; keep only numeric entries
    // rather than passing through something the contract would reject.
    if (typeof run.progress === 'object' && run.progress !== null && !Array.isArray(run.progress)) {
      for (const [key, value] of Object.entries(run.progress as Record<string, unknown>)) {
        if (typeof value === 'number') progress[key] = value;
      }
    }
    return {
      id: run.id,
      runNumber: run.runNumber,
      status: run.status,
      progress,
      batesStart: run.batesStart,
      batesEnd: run.batesEnd,
      exceptionCounts,
      manifestSha256: run.manifestSha256,
    };
  }

  private toDto(row: {
    id: string;
    name: string;
    description: string;
    status: ProductionStatus;
    caseId: string | null;
    createdAt: Date;
    version: number;
    draftParameters: unknown;
  }): ProductionDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      caseId: row.caseId,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
      draftParameters: row.draftParameters,
    };
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: ProductionDto[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.production.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const slice = rows.slice(0, page.limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((row) => this.toDto(row)),
      nextCursor: rows.length > page.limit && last ? last.id : null,
    };
  }

  async get(
    auth: AuthContext,
    id: string,
  ): Promise<ProductionDto & { parameters: unknown; runs: ProductionRunDto[] }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const row = await tx.production.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { runs: { orderBy: { runNumber: 'asc' } } },
      });
      if (!row) throw new NotFoundException();

      // One grouped query for all runs rather than one per run: a production
      // with many runs would otherwise fan out into N round trips.
      const groups =
        row.runs.length === 0
          ? []
          : await tx.productionException.groupBy({
              by: ['productionRunId', 'code'],
              where: {
                tenantId: auth.tenantId,
                productionRunId: { in: row.runs.map((r) => r.id) },
              },
              _count: { _all: true },
            });
      const countsByRun = new Map<string, Record<string, number>>();
      for (const g of groups) {
        const existing = countsByRun.get(g.productionRunId) ?? {};
        existing[g.code] = g._count._all;
        countsByRun.set(g.productionRunId, existing);
      }

      return {
        ...this.toDto(row),
        // The client reads `parameters`; the column is draftParameters.
        parameters: row.draftParameters,
        runs: row.runs.map((run) =>
          ProductionsService.toRunDto(run, countsByRun.get(run.id) ?? {}),
        ),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Selection resolution
  // -------------------------------------------------------------------------

  /** Resolve the draft selection into a deterministic, sorted id list. */
  private async resolveSelectionIds(
    tenantId: string,
    parameters: ProductionParameters,
  ): Promise<string[]> {
    const selection = parameters.selection;

    // Saved searches resolve through the search engine (system context).
    const searchIds = new Set<string>();
    for (const savedSearchId of selection.savedSearchIds) {
      const ids = await this.selection.collectIdsForSavedSearch(tenantId, savedSearchId);
      for (const id of ids) searchIds.add(id);
    }

    return withTenantContext(this.prisma, tenantId, async (tx) => {
      const base = new Set<string>(searchIds);
      if (selection.tagIds.length > 0) {
        const assignments = await tx.tagAssignment.findMany({
          where: { tenantId, tagId: { in: selection.tagIds } },
          select: { evidenceItemId: true },
        });
        for (const assignment of assignments) base.add(assignment.evidenceItemId);
      }

      let ids: string[];
      if (selection.inverted) {
        const all = await tx.evidenceItem.findMany({
          where: { tenantId, id: { notIn: [...base].slice(0, SELECTION_ID_CAP) } },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: SELECTION_ID_CAP,
        });
        ids = all.map((row) => row.id);
      } else {
        ids = [...base];
      }

      // Previously-produced exclusion via the ProductionItem join.
      const exclusion = selection.excludePreviouslyProduced;
      if (exclusion.kind !== 'none' && ids.length > 0) {
        const produced = await tx.productionItem.findMany({
          where: {
            tenantId,
            evidenceItemId: { in: ids },
            ...(exclusion.kind === 'selected'
              ? { productionRun: { productionId: { in: exclusion.productionIds } } }
              : {}),
          },
          select: { evidenceItemId: true },
        });
        const excluded = new Set(produced.map((p) => p.evidenceItemId));
        ids = ids.filter((id) => !excluded.has(id));
      }

      if (selection.includeFamilies && ids.length > 0) {
        ids = await expandFamilies(tx, tenantId, ids);
      }

      return ids.sort();
    });
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Map database rows onto the validator's per-item fact sheet. */
  private async loadValidationItems(
    tx: TenantScopedTx,
    tenantId: string,
    ids: string[],
    parameters: ProductionParameters,
  ): Promise<ProductionValidationItem[]> {
    interface ItemRow {
      id: string;
      kind: string;
      extension: string;
      size: bigint;
      blobId: string | null;
      processingStatus: string;
      processingDetail: string;
      malwareStatus: MalwareStatus;
    }
    const items: ItemRow[] = [];
    const encrypted = new Set<string>();
    const finalRedacted = new Set<string>();
    const previewRedacted = new Set<string>();
    const privileged = new Set<string>();
    const hasText = new Set<string>();
    const duplicates = new Set<string>();
    const policyTagged = new Set<string>();
    const parentOf = new Map<string, string>();
    const inFamily = new Set<string>();

    for (const idChunk of chunk(ids, QUERY_CHUNK)) {
      items.push(
        ...(await tx.evidenceItem.findMany({
          where: { tenantId, id: { in: idChunk } },
          select: {
            id: true,
            kind: true,
            extension: true,
            size: true,
            blobId: true,
            processingStatus: true,
            processingDetail: true,
            malwareStatus: true,
          },
        })),
      );
      for (const row of await tx.emailMetadata.findMany({
        where: { tenantId, evidenceItemId: { in: idChunk }, isEncrypted: true },
        select: { evidenceItemId: true },
      })) {
        encrypted.add(row.evidenceItemId);
      }
      for (const row of await tx.redaction.findMany({
        where: { tenantId, evidenceItemId: { in: idChunk } },
        select: { evidenceItemId: true, stage: true },
      })) {
        (row.stage === RedactionStage.final ? finalRedacted : previewRedacted).add(
          row.evidenceItemId,
        );
      }
      for (const row of await tx.tagAssignment.findMany({
        where: { tenantId, evidenceItemId: { in: idChunk }, tag: { isPrivileged: true } },
        select: { evidenceItemId: true },
      })) {
        privileged.add(row.evidenceItemId);
      }
      for (const row of await tx.extractedText.findMany({
        where: { tenantId, evidenceItemId: { in: idChunk } },
        select: { evidenceItemId: true },
        distinct: ['evidenceItemId'],
      })) {
        hasText.add(row.evidenceItemId);
      }
      for (const rel of await tx.evidenceRelationship.findMany({
        where: {
          tenantId,
          kind: { in: FAMILY_REL_KINDS },
          OR: [{ parentId: { in: idChunk } }, { childId: { in: idChunk } }],
        },
        select: { parentId: true, childId: true },
      })) {
        if (!parentOf.has(rel.childId)) parentOf.set(rel.childId, rel.parentId);
        inFamily.add(rel.parentId);
        inFamily.add(rel.childId);
      }
      for (const rel of await tx.evidenceRelationship.findMany({
        where: { tenantId, kind: RelationshipKind.duplicate_of, childId: { in: idChunk } },
        select: { childId: true },
      })) {
        duplicates.add(rel.childId);
      }
      if (parameters.nativePolicy.tagIds.length > 0) {
        for (const row of await tx.tagAssignment.findMany({
          where: {
            tenantId,
            evidenceItemId: { in: idChunk },
            tagId: { in: parameters.nativePolicy.tagIds },
          },
          select: { evidenceItemId: true },
        })) {
          policyTagged.add(row.evidenceItemId);
        }
      }
    }

    const familyRoot = (id: string): string => {
      let current = id;
      const seen = new Set<string>();
      while (parentOf.has(current) && !seen.has(current)) {
        seen.add(current);
        current = parentOf.get(current) as string;
      }
      return current;
    };

    const output = parameters.output;
    const policyExtensions = new Set(parameters.nativePolicy.extensions);
    const policyHasFilters =
      parameters.nativePolicy.extensions.length > 0 || parameters.nativePolicy.tagIds.length > 0;

    const wouldProduceNative = (item: ItemRow): boolean => {
      if (output.mode === 'natives_only') return true;
      if (output.mode !== 'load_file' || !output.includeNatives) return false;
      if (!policyHasFilters) return true;
      return policyExtensions.has(item.extension.toLowerCase()) || policyTagged.has(item.id);
    };

    const malwareMap: Record<MalwareStatus, ProductionValidationItem['malwareStatus']> = {
      [MalwareStatus.clean]: 'clean',
      [MalwareStatus.not_scanned]: 'unscanned',
      [MalwareStatus.scan_failed]: 'suspicious',
      [MalwareStatus.infected]: 'infected',
    };

    return items.map((item) => {
      const ext = item.extension.toLowerCase();
      const detail = item.processingDetail.toLowerCase();
      return {
        evidenceId: item.id,
        familyId: inFamily.has(item.id) ? familyRoot(item.id) : null,
        parentId: parentOf.get(item.id) ?? null,
        hasFinalRedactions: finalRedacted.has(item.id),
        hasPreviewRedactions: previewRedacted.has(item.id),
        isPrivileged: privileged.has(item.id),
        isArchiveContainer: item.kind === 'container' || ARCHIVE_EXTENSIONS.has(ext),
        isDuplicate: duplicates.has(item.id),
        malwareStatus: malwareMap[item.malwareStatus],
        hasNative: item.blobId !== null,
        conversionSupported: CONVERTIBLE_EXTENSIONS.has(ext),
        processed: !['pending', 'failed', 'exception'].includes(item.processingStatus),
        isEncrypted: encrypted.has(item.id) || detail.includes('encrypted'),
        hasText: hasText.has(item.id),
        sizeBytes: Number(item.size),
        wouldProduceNative: wouldProduceNative(item),
        isCorrupt: detail.includes('corrupt'),
      };
    });
  }

  private parseDraftParameters(draft: unknown): ProductionParameters {
    const parsed = productionParameters.safeParse(draft);
    if (!parsed.success) {
      throw new ConflictException('draft parameters are incomplete; update the draft first');
    }
    return parsed.data;
  }

  private readSnapshot(draft: unknown): ValidationSnapshot | null {
    if (typeof draft !== 'object' || draft === null) return null;
    const raw = (draft as Record<string, unknown>).validation;
    const parsed = validationSnapshotSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async validate(
    auth: AuthContext,
    id: string,
    request: FastifyRequest,
  ): Promise<{
    draftCalculatedAt: string;
    itemCount: number;
    estimatedPageCount: number | null;
    flags: ValidationFlag[];
    canSubmit: boolean;
  }> {
    const production = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.production.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!production) throw new NotFoundException();
    if (production.status !== ProductionStatus.draft) {
      throw new ConflictException('only draft productions can be validated');
    }
    const parameters = this.parseDraftParameters(production.draftParameters);

    const ids = await this.resolveSelectionIds(auth.tenantId, parameters);
    const flags = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const items = await this.loadValidationItems(tx, auth.tenantId, ids, parameters);
      return validateProductionSet(items, {
        includeFamilies: parameters.selection.includeFamilies,
        redactionStage: parameters.redactions.stage,
        output: parameters.output,
      });
    });

    const calculatedAt = new Date().toISOString();
    const snapshot: ValidationSnapshot = {
      calculatedAt,
      itemCount: ids.length,
      itemIdsHash: idsHash(ids),
      flags: flags.map((flag) => ({
        code: flag.code,
        severity: flag.severity,
        overridable: flag.overridable,
        requiresElevatedOverride: flag.requiresElevatedOverride,
        count: flag.evidenceItemIds.length,
      })),
    };

    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await tx.production.update({
        where: { id },
        data: {
          draftParameters: {
            ...parameters,
            validation: snapshot,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'production.validated',
        targetType: 'production',
        targetId: id,
        summary: {
          itemCount: ids.length,
          flagCodes: flags.map((flag) => `${flag.code}:${flag.evidenceItemIds.length}`),
        },
        request,
      });
    });

    // Submittable unless a flag is neither overridable nor elevated-overridable.
    const canSubmit = flags.every(
      (flag) =>
        flag.severity === 'info' ||
        flag.severity === 'warning' ||
        flag.overridable ||
        flag.requiresElevatedOverride,
    );

    return {
      draftCalculatedAt: calculatedAt,
      itemCount: ids.length,
      estimatedPageCount: ids.length,
      flags,
      canSubmit,
    };
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async submit(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{
    productionId: string;
    runId: string;
    runNumber: number;
    batesStart: string;
    batesEnd: string;
  }> {
    const input = zodValidate(submitProductionRequest, body);

    const production = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.production.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!production) throw new NotFoundException();
    if (production.status !== ProductionStatus.draft) {
      throw new ConflictException('only draft productions can be submitted');
    }
    const parameters = this.parseDraftParameters(production.draftParameters);
    const snapshot = this.readSnapshot(production.draftParameters);
    if (!snapshot) {
      throw new BadRequestException('run validation before submitting');
    }
    if (input.expectedDraftCalculatedAt !== snapshot.calculatedAt) {
      throw new ConflictException(
        'the draft was re-validated since this confirmation; review the latest validation',
      );
    }

    // Acknowledgement checks against the validated snapshot.
    const acksByCode = new Map<string, (typeof input.acknowledgedWarnings)[number]>(
      input.acknowledgedWarnings.map((ack) => [ack.code, ack]),
    );
    const needingAck = snapshot.flags.filter(
      (flag) => flag.severity === 'blocking' || flag.severity === 'security_critical',
    );
    const missing = needingAck.filter((flag) => !acksByCode.has(flag.code));
    if (missing.length > 0) {
      throw new BadRequestException({
        message: 'blocking validation flags must be acknowledged',
        missingAcknowledgements: missing.map((flag) => flag.code),
      });
    }
    for (const flag of needingAck) {
      if (flag.severity !== 'security_critical') continue;
      const ack = acksByCode.get(flag.code);
      if (!ack || !ack.secondConfirmation) {
        // Route roles already restrict submit to production_manager; the
        // second confirmation is an explicit, separate act.
        throw new ForbiddenException({
          message: `security-critical flag '${flag.code}' requires a production_manager second confirmation`,
          code: flag.code,
        });
      }
    }

    // Selection must be byte-identical to what was validated.
    const ids = await this.resolveSelectionIds(auth.tenantId, parameters);
    if (idsHash(ids) !== snapshot.itemIdsHash) {
      throw new ConflictException({
        message: FLAG_DEFINITIONS.selection_changed_since_draft.message,
        code: 'selection_changed_since_draft',
      });
    }

    const acknowledgedWarnings = input.acknowledgedWarnings.map((ack) => ({
      code: ack.code,
      note: ack.note,
      secondConfirmation: ack.secondConfirmation,
      ackById: auth.userId,
      ackAt: new Date().toISOString(),
    }));

    const bates = parameters.bates;
    const expectedPages = BigInt(Math.max(ids.length, 1));
    const startNumber = BigInt(bates.startNumber);
    const endNumber = startNumber + expectedPages * 3n;

    return withTenantContext(
      this.prisma,
      auth.tenantId,
      async (tx) => {
        // Bates ranges are exclusive per tenant+prefix: overlap is a 409.
        const overlapping = await tx.batesReservation.findFirst({
          where: {
            tenantId: auth.tenantId,
            prefix: bates.prefix,
            startNumber: { lte: endNumber },
            endNumber: { gte: startNumber },
          },
          orderBy: { endNumber: 'desc' },
        });
        if (overlapping) {
          throw new ConflictException({
            message: 'requested bates range overlaps an existing reservation for this prefix',
            code: 'duplicate_bates_range',
            nextFreeStart: (overlapping.endNumber + 1n).toString(),
          });
        }

        const lastRun = await tx.productionRun.aggregate({
          where: { tenantId: auth.tenantId, productionId: id },
          _max: { runNumber: true },
        });
        const runNumber = (lastRun._max.runNumber ?? 0) + 1;
        const batesStart = formatBates(bates.prefix, startNumber, bates.digits, bates.suffix);
        const batesEnd = formatBates(bates.prefix, endNumber, bates.digits, bates.suffix);

        const run = await tx.productionRun.create({
          data: {
            tenantId: auth.tenantId,
            productionId: id,
            runNumber,
            // Worker contract: full wizard parameters + frozen selection ids.
            frozenParameters: {
              ...parameters,
              selectionItemIds: ids,
            } as unknown as Prisma.InputJsonValue,
            selectionSnapshotSha256: snapshot.itemIdsHash,
            acknowledgedWarnings: acknowledgedWarnings as unknown as Prisma.InputJsonValue,
            status: 'queued',
            batesStart,
            batesEnd,
            createdById: auth.userId,
          },
        });
        await tx.batesReservation.create({
          data: {
            tenantId: auth.tenantId,
            productionRunId: run.id,
            prefix: bates.prefix,
            suffix: bates.suffix,
            digits: bates.digits,
            startNumber,
            endNumber,
          },
        });
        await tx.outboxEvent.create({
          data: {
            tenantId: auth.tenantId,
            topic: 'production.run',
            dedupKey: `production-run:${run.id}`,
            payload: { tenantId: auth.tenantId, productionRunId: run.id },
          },
        });
        await tx.production.update({
          where: { id },
          data: { status: ProductionStatus.submitted },
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'production.submitted',
          targetType: 'production',
          targetId: id,
          summary: {
            runNumber,
            itemCount: ids.length,
            batesStart,
            batesEnd,
            acknowledgedWarnings: acknowledgedWarnings.map((ack) => ({
              code: ack.code,
              secondConfirmation: ack.secondConfirmation,
            })),
          },
          request,
        });
        return { productionId: id, runId: run.id, runNumber, batesStart, batesEnd };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  async getRun(
    auth: AuthContext,
    productionId: string,
    runId: string,
  ): Promise<{
    id: string;
    runNumber: number;
    status: string;
    progress: Record<string, number>;
    batesStart: string;
    batesEnd: string;
    exceptionCounts: Record<string, number>;
    manifestSha256: string;
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const run = await tx.productionRun.findFirst({
        where: { id: runId, productionId, tenantId: auth.tenantId },
      });
      if (!run) throw new NotFoundException();
      const exceptionGroups = await tx.productionException.groupBy({
        by: ['code'],
        where: { tenantId: auth.tenantId, productionRunId: run.id },
        _count: { _all: true },
      });
      const exceptionCounts: Record<string, number> = {};
      for (const group of exceptionGroups) exceptionCounts[group.code] = group._count._all;


      return ProductionsService.toRunDto(run, exceptionCounts);
    });
  }

  /** Clone a run's frozen parameters into a fresh draft production. */
  async cloneRun(
    auth: AuthContext,
    productionId: string,
    runId: string,
    request: FastifyRequest,
  ): Promise<{ id: string; status: string }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const run = await tx.productionRun.findFirst({
        where: { id: runId, productionId, tenantId: auth.tenantId },
        include: { production: { select: { caseId: true, name: true } } },
      });
      if (!run) throw new NotFoundException();

      // frozenParameters = parameters + selectionItemIds; parsing with the
      // contract schema strips the frozen ids and any bookkeeping fields.
      const parsed = productionParameters.safeParse(run.frozenParameters);
      if (!parsed.success) {
        throw new ConflictException('frozen parameters of this run cannot be cloned');
      }
      const parameters = parsed.data;
      const name = `${parameters.name} (run ${run.runNumber} copy)`;

      const created = await tx.production.create({
        data: {
          tenantId: auth.tenantId,
          caseId: run.production.caseId,
          name,
          description: parameters.description,
          status: ProductionStatus.draft,
          draftParameters: { ...parameters, name } as unknown as Prisma.InputJsonValue,
          idempotencyKey: `clone:${run.id}:${randomUUID()}`,
          createdById: auth.userId,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'production.cloned',
        targetType: 'production',
        targetId: created.id,
        summary: { sourceProductionId: productionId, sourceRunId: runId, name },
        request,
      });
      return { id: created.id, status: created.status };
    });
  }
}
