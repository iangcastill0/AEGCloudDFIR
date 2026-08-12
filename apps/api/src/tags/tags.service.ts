import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  Prisma,
  TagFamilyBehavior,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import { bulkTagRequest, createTagRequest } from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, expandDescendants, expandFamilies } from '../common/families.js';
import { AuditService } from '../audit/audit.service.js';

const BULK_CHUNK_SIZE = 500;

const updateTagSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  description: z.string().max(500).optional(),
  isPrivileged: z.boolean().optional(),
  isConfidential: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  familyBehavior: z.enum(['none', 'apply_to_family', 'apply_to_descendants']).optional(),
  version: z.number().int().min(1),
});

export interface TagDto {
  id: string;
  name: string;
  color: string;
  description: string;
  isPrivileged: boolean;
  isConfidential: boolean;
  isHidden: boolean;
  familyBehavior: string;
  createdAt: string;
  version: number;
}

type TagRow = {
  id: string;
  name: string;
  color: string;
  description: string;
  isPrivileged: boolean;
  isConfidential: boolean;
  isHidden: boolean;
  familyBehavior: TagFamilyBehavior;
  createdAt: Date;
  version: number;
};

function toDto(row: TagRow): TagDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    isPrivileged: row.isPrivileged,
    isConfidential: row.isConfidential,
    isHidden: row.isHidden,
    familyBehavior: row.familyBehavior,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

@Injectable()
export class TagsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, body: unknown, request: FastifyRequest): Promise<TagDto> {
    const input = zodValidate(createTagRequest, body);
    try {
      const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
        const created = await tx.tag.create({
          data: { tenantId: auth.tenantId, ...input, createdById: auth.userId },
        });
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'tag.created',
          targetType: 'tag',
          targetId: created.id,
          summary: { name: input.name, isPrivileged: input.isPrivileged },
          request,
        });
        return created;
      });
      return toDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('a tag with this name already exists');
      }
      throw err;
    }
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: TagDto[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.tag.findMany({
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

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<TagDto> {
    const input = zodValidate(updateTagSchema, body);
    const { version, ...fields } = input;
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const existing = await tx.tag.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException();
      const updated = await tx.tag.updateMany({
        where: { id, tenantId: auth.tenantId, version },
        data: { ...fields, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ConflictException('tag was modified concurrently; reload and retry');
      }
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'tag.updated',
        targetType: 'tag',
        targetId: id,
        summary: { changedFields: Object.keys(fields) },
        request,
      });
      return tx.tag.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
    });
    return toDto(row);
  }

  async remove(
    auth: AuthContext,
    id: string,
    force: boolean,
    request: FastifyRequest,
  ): Promise<{ ok: true; assignmentsRemoved: number }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const existing = await tx.tag.findFirst({ where: { id, tenantId: auth.tenantId } });
      if (!existing) throw new NotFoundException();
      const assignmentCount = await tx.tagAssignment.count({
        where: { tenantId: auth.tenantId, tagId: id },
      });
      if (assignmentCount > 0 && !force) {
        throw new ConflictException(
          `tag has ${assignmentCount} assignments; pass ?force=1 to delete them as well`,
        );
      }
      // FK cascade removes assignments (and their notes).
      await tx.tag.delete({ where: { id } });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'tag.deleted',
        targetType: 'tag',
        targetId: id,
        summary: { name: existing.name, assignmentsRemoved: assignmentCount, forced: force },
        request,
      });
      return { ok: true as const, assignmentsRemoved: assignmentCount };
    });
  }

  /** Expand requested item ids per the tag's family behavior. */
  private async expandForBehavior(
    tx: TenantScopedTx,
    tenantId: string,
    behavior: TagFamilyBehavior,
    ids: string[],
  ): Promise<string[]> {
    if (behavior === TagFamilyBehavior.apply_to_family) {
      return expandFamilies(tx, tenantId, ids);
    }
    if (behavior === TagFamilyBehavior.apply_to_descendants) {
      return expandDescendants(tx, tenantId, ids);
    }
    return [...ids];
  }

  async bulk(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ action: string; requested: number; expanded: number; affected: number }> {
    const input = zodValidate(bulkTagRequest, body);

    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const tag = await tx.tag.findFirst({ where: { id: input.tagId, tenantId: auth.tenantId } });
      if (!tag) throw new NotFoundException();
      if (input.expectedTagVersion !== undefined && tag.version !== input.expectedTagVersion) {
        throw new ConflictException('tag definition changed concurrently; reload and retry');
      }

      // Only ids that exist in this tenant participate (silent skip).
      const requestedRows = await tx.evidenceItem.findMany({
        where: { tenantId: auth.tenantId, id: { in: input.evidenceItemIds } },
        select: { id: true },
      });
      const requestedIds = requestedRows.map((r) => r.id);
      const expandedIds = await this.expandForBehavior(
        tx,
        auth.tenantId,
        tag.familyBehavior,
        requestedIds,
      );

      let affected = 0;
      if (input.action === 'apply') {
        for (const ids of chunk(expandedIds, BULK_CHUNK_SIZE)) {
          const result = await tx.tagAssignment.createMany({
            data: ids.map((evidenceItemId) => ({
              tenantId: auth.tenantId,
              tagId: tag.id,
              evidenceItemId,
              assignedById: auth.userId,
            })),
            skipDuplicates: true,
          });
          affected += result.count;
        }
        if (input.note !== undefined && input.note.length > 0) {
          // Notes attach to the directly requested items' assignments.
          const assignments = await tx.tagAssignment.findMany({
            where: {
              tenantId: auth.tenantId,
              tagId: tag.id,
              evidenceItemId: { in: requestedIds },
            },
            select: { id: true },
          });
          await tx.tagNote.createMany({
            data: assignments.map((assignment) => ({
              tenantId: auth.tenantId,
              tagAssignmentId: assignment.id,
              authorId: auth.userId,
              text: input.note ?? '',
            })),
          });
        }
      } else {
        for (const ids of chunk(expandedIds, BULK_CHUNK_SIZE)) {
          const result = await tx.tagAssignment.deleteMany({
            where: { tenantId: auth.tenantId, tagId: tag.id, evidenceItemId: { in: ids } },
          });
          affected += result.count;
        }
      }

      // Re-index affected items so tag facets update (worker contract shape).
      const versions = await tx.evidenceItem.findMany({
        where: { tenantId: auth.tenantId, id: { in: expandedIds } },
        select: { id: true, version: true },
      });
      for (const rows of chunk(versions, BULK_CHUNK_SIZE)) {
        await tx.outboxEvent.createMany({
          data: rows.map((row) => ({
            tenantId: auth.tenantId,
            topic: 'search.index',
            dedupKey: `index:${row.id}:v${row.version}`,
            payload: { tenantId: auth.tenantId, evidenceItemId: row.id, version: row.version },
          })),
          skipDuplicates: true,
        });
      }

      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: input.action === 'apply' ? 'tag.bulk_applied' : 'tag.bulk_removed',
        targetType: 'tag',
        targetId: tag.id,
        summary: {
          tagName: tag.name,
          requested: requestedIds.length,
          expanded: expandedIds.length,
          affected,
          familyBehavior: tag.familyBehavior,
          withNote: input.note !== undefined && input.note.length > 0,
        },
        request,
      });

      return {
        action: input.action,
        requested: requestedIds.length,
        expanded: expandedIds.length,
        affected,
      };
    });
  }
}
