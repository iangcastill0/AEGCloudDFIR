import { createHash, randomUUID } from 'node:crypto';
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
} from '@evidencevault/database';
import {
  createProductionRequest,
  productionParameters,
  submitProductionRequest,
  type ProductionParameters,
} from '@evidencevault/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { assertWithinQuota, readQuota } from '../common/quotas.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, expandFamilies } from '../common/families.js';
import { AuditService } from '../audit/audit.service.js';
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

@Injectable()
export class ProductionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly selection: SelectionService,
  ) {}

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
  ): Promise<ProductionDto & { runs: { id: string; runNumber: number; status: string }[] }> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.production.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { runs: { orderBy: { runNumber: 'asc' } } },
      }),
    );
    if (!row) throw new NotFoundException();
    return {
      ...this.toDto(row),
      runs: row.runs.map((run) => ({ id: run.id, runNumber: run.runNumber, status: run.status })),
    };
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

      const progress: Record<string, number> = {};
      if (
        typeof run.progress === 'object' &&
        run.progress !== null &&
        !Array.isArray(run.progress)
      ) {
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
