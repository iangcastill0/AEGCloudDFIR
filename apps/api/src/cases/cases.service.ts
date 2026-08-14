import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CaseRole,
  CaseStatus,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import { addCaseItemsRequest, createCaseRequest } from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, expandFamilies } from '../common/families.js';
import { isCaseRestricted } from '../common/roles.js';
import { AuditService } from '../audit/audit.service.js';
import { SelectionService } from '../search/selection.service.js';

const ITEM_INSERT_CHUNK = 1000;

const updateCaseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  matterNumber: z.string().max(100).optional(),
  client: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(['open', 'closed', 'archived']).optional(),
  version: z.number().int().min(1),
});

/** A note must say something; 8k is generous for commentary but bounded. */
const noteSchema = z.object({ text: z.string().trim().min(1).max(8000) });

const memberSchema = z.object({
  membershipId: z.string().uuid(),
  role: z.enum(['case_manager', 'reviewer', 'read_only', 'production_manager']),
});

const holdSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(2000),
});

export interface CaseDto {
  id: string;
  name: string;
  matterNumber: string;
  client: string;
  description: string;
  status: string;
  legalHold: boolean;
  createdAt: string;
  version: number;
}

type CaseRow = {
  id: string;
  name: string;
  matterNumber: string;
  client: string;
  description: string;
  status: CaseStatus;
  legalHold: boolean;
  createdAt: Date;
  version: number;
};

function toDto(row: CaseRow): CaseDto {
  return {
    id: row.id,
    name: row.name,
    matterNumber: row.matterNumber,
    client: row.client,
    description: row.description,
    status: row.status,
    legalHold: row.legalHold,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

@Injectable()
export class CasesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly selection: SelectionService,
  ) {}

  /**
   * Load a case; callers without a tenant-wide read role must be members.
   * A non-member sees 404 (no existence leakage).
   */
  private async requireCase(tx: TenantScopedTx, auth: AuthContext, id: string) {
    const row = await tx.case.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!row) throw new NotFoundException();
    if (isCaseRestricted(auth)) {
      const member = await tx.caseMember.count({
        where: { tenantId: auth.tenantId, caseId: id, membershipId: auth.membershipId },
      });
      if (member === 0) throw new NotFoundException();
    }
    return row;
  }

  async create(auth: AuthContext, body: unknown, request: FastifyRequest): Promise<CaseDto> {
    const input = zodValidate(createCaseRequest, body);
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const created = await tx.case.create({
        data: { tenantId: auth.tenantId, ...input, createdById: auth.userId },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.created',
        targetType: 'case',
        targetId: created.id,
        summary: { name: input.name, matterNumber: input.matterNumber },
        request,
      });
      return created;
    });
    return toDto(row);
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: CaseDto[]; nextCursor: string | null }> {
    const restricted = isCaseRestricted(auth);
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.case.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(restricted ? { members: { some: { membershipId: auth.membershipId } } } : {}),
        },
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

  async get(auth: AuthContext, id: string): Promise<CaseDto> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      this.requireCase(tx, auth, id),
    );
    return toDto(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<CaseDto> {
    const input = zodValidate(updateCaseSchema, body);
    const { version, ...fields } = input;
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const updated = await tx.case.updateMany({
        where: { id, tenantId: auth.tenantId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ConflictException('case was modified concurrently; reload and retry');
      }
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.updated',
        targetType: 'case',
        targetId: id,
        summary: { changedFields: Object.keys(fields) },
        request,
      });
      return tx.case.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
    });
    return toDto(row);
  }

  /** Reference-only: adding items never copies or mutates evidence. */
  async addItems(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ requested: number; added: number }> {
    const input = zodValidate(addCaseItemsRequest, body);

    // Saved-search resolution happens through the search engine (outside the
    // tx); the ids are then verified against the tenant inside it.
    let sourceIds: string[];
    let addedVia: string;
    if (input.source.kind === 'items') {
      sourceIds = input.source.evidenceItemIds;
      addedVia = 'manual';
    } else if (input.source.kind === 'saved_search') {
      sourceIds = await this.selection.collectIdsForSavedSearch(
        auth.tenantId,
        input.source.savedSearchId,
      );
      addedVia = 'search';
    } else {
      sourceIds = [];
      addedVia = 'tag';
    }

    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);

      if (input.source.kind === 'tag') {
        const tag = await tx.tag.findFirst({
          where: { id: input.source.tagId, tenantId: auth.tenantId },
          select: { id: true },
        });
        if (!tag) throw new NotFoundException();
        const assignments = await tx.tagAssignment.findMany({
          where: { tenantId: auth.tenantId, tagId: tag.id },
          select: { evidenceItemId: true },
        });
        sourceIds = assignments.map((a) => a.evidenceItemId);
      } else if (input.source.kind === 'items') {
        const rows = await tx.evidenceItem.findMany({
          where: { tenantId: auth.tenantId, id: { in: sourceIds } },
          select: { id: true },
        });
        if (rows.length !== sourceIds.length) {
          throw new BadRequestException('one or more evidenceItemIds do not exist');
        }
      }

      const finalIds = input.includeFamilies
        ? await expandFamilies(tx, auth.tenantId, sourceIds)
        : [...new Set(sourceIds)];

      let added = 0;
      for (const ids of chunk(finalIds, ITEM_INSERT_CHUNK)) {
        const result = await tx.caseItem.createMany({
          data: ids.map((evidenceItemId) => ({
            tenantId: auth.tenantId,
            caseId: id,
            evidenceItemId,
            addedById: auth.userId,
            addedVia,
          })),
          skipDuplicates: true,
        });
        added += result.count;
      }

      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.items_added',
        targetType: 'case',
        targetId: id,
        summary: {
          sourceKind: input.source.kind,
          requested: sourceIds.length,
          withFamilies: finalIds.length,
          added,
        },
        request,
      });

      return { requested: sourceIds.length, added };
    });
  }

  async items(
    auth: AuthContext,
    id: string,
    page: CursorQuery,
  ): Promise<{
    items: { id: string; evidenceItemId: string; name: string; kind: string; addedVia: string }[];
    nextCursor: string | null;
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const rows = await tx.caseItem.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        include: { evidenceItem: { select: { name: true, kind: true } } },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      });
      const slice = rows.slice(0, page.limit);
      const last = slice[slice.length - 1];
      return {
        items: slice.map((row) => ({
          id: row.id,
          evidenceItemId: row.evidenceItemId,
          name: row.evidenceItem.name,
          kind: row.evidenceItem.kind,
          addedVia: row.addedVia,
        })),
        nextCursor: rows.length > page.limit && last ? last.id : null,
      };
    });
  }

  /**
   * Members of a case, with the identity behind each membership.
   *
   * The membership id alone is meaningless in a UI, so the user's email and
   * display name are joined in — otherwise a reviewer sees a list of UUIDs and
   * cannot tell who has access to a matter.
   */
  async members(
    auth: AuthContext,
    id: string,
  ): Promise<{
    items: {
      membershipId: string;
      role: string;
      email: string;
      displayName: string;
      addedAt: string;
    }[];
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const rows = await tx.caseMember.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        include: { membership: { include: { user: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return {
        items: rows.map((row) => ({
          membershipId: row.membershipId,
          role: row.role,
          email: row.membership.user.email,
          displayName: row.membership.user.displayName,
          addedAt: row.createdAt.toISOString(),
        })),
      };
    });
  }

  /** Case notes, oldest first: they read as a running commentary on the matter. */
  async notes(
    auth: AuthContext,
    id: string,
  ): Promise<{
    items: { id: string; text: string; authorId: string | null; createdAt: string }[];
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const rows = await tx.caseNote.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          text: row.text,
          authorId: row.authorId,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    });
  }

  /**
   * Add a note. Audited, because a note is commentary on a matter that may later
   * be read as part of the record — who wrote what, and when, has to be
   * attributable rather than inferred from a mutable row.
   */
  async addNote(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ id: string; text: string; authorId: string | null; createdAt: string }> {
    const input = zodValidate(noteSchema, body);
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const note = await tx.caseNote.create({
        data: {
          tenantId: auth.tenantId,
          caseId: id,
          authorId: auth.userId,
          text: input.text,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.note_added',
        targetType: 'case',
        targetId: id,
        summary: { noteId: note.id, charCount: input.text.length },
        request,
      });
      return {
        id: note.id,
        text: note.text,
        authorId: note.authorId,
        createdAt: note.createdAt.toISOString(),
      };
    });
  }

  async addMember(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const input = zodValidate(memberSchema, body);
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const membership = await tx.membership.findFirst({
        where: { id: input.membershipId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!membership) throw new NotFoundException();
      await tx.caseMember.upsert({
        where: { caseId_membershipId: { caseId: id, membershipId: input.membershipId } },
        create: {
          tenantId: auth.tenantId,
          caseId: id,
          membershipId: input.membershipId,
          role: input.role as CaseRole,
        },
        update: { role: input.role as CaseRole },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.member_added',
        targetType: 'case',
        targetId: id,
        summary: { membershipId: input.membershipId, role: input.role },
        request,
      });
    });
    return { ok: true };
  }

  async removeMember(
    auth: AuthContext,
    id: string,
    membershipId: string,
    request: FastifyRequest,
  ): Promise<{ ok: true }> {
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const deleted = await tx.caseMember.deleteMany({
        where: { tenantId: auth.tenantId, caseId: id, membershipId },
      });
      if (deleted.count === 0) throw new NotFoundException();
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.member_removed',
        targetType: 'case',
        targetId: id,
        summary: { membershipId },
        request,
      });
    });
    return { ok: true };
  }

  async setHold(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<CaseDto> {
    const input = zodValidate(holdSchema, body);
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const updated = await tx.case.update({
        where: { id },
        data: {
          legalHold: input.enabled,
          legalHoldSetAt: new Date(),
          legalHoldSetById: auth.userId,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'case.hold_changed',
        targetType: 'case',
        targetId: id,
        summary: { enabled: input.enabled, reason: input.reason },
        request,
      });
      return updated;
    });
    return toDto(row);
  }
}
