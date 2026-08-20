import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { savedSearchRequest } from '@aeg-clouddfir/contracts';
import { withTenantContext, type Prisma, type PrismaClient } from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { zodValidate } from '../common/zod-validate.js';
import { AuditService } from '../audit/audit.service.js';
import { SearchService } from './search.service.js';

const updateSchema = z.object({ version: z.number().int().min(1) });

export interface SavedSearchDto {
  id: string;
  name: string;
  caseId: string | null;
  queryText: string;
  /** Which language queryText is written in, so the client edits it correctly. */
  syntax: 'simple' | 'advanced';
  queryAst: unknown;
  createdAt: string;
  version: number;
}

type SavedSearchRow = {
  id: string;
  name: string;
  caseId: string | null;
  queryText: string;
  syntax: string;
  queryAst: unknown;
  createdAt: Date;
  version: number;
};

function toDto(row: SavedSearchRow): SavedSearchDto {
  return {
    id: row.id,
    name: row.name,
    caseId: row.caseId,
    queryText: row.queryText,
    // Anything unexpected in the column reads as 'simple', which is what every
    // row written before this feature actually is.
    syntax: row.syntax === 'advanced' ? 'advanced' : 'simple',
    queryAst: row.queryAst,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

@Injectable()
export class SavedSearchesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly search: SearchService,
    private readonly audit: AuditService,
  ) {}

  /** Parse + validate the request, deriving the stored AST from queryText. */
  private validateBody(body: unknown): {
    name: string;
    caseId?: string;
    queryText: string;
    syntax: 'simple' | 'advanced';
    queryAst: Prisma.InputJsonValue;
  } {
    const input = zodValidate(savedSearchRequest, body);
    // The stored AST is ALWAYS validated — never a raw engine query.
    const ast = this.search.parseOrValidate(input.queryText, input.queryAst, input.syntax);
    return {
      name: input.name,
      caseId: input.caseId,
      queryText: input.queryText,
      syntax: input.syntax,
      queryAst: ast as Prisma.InputJsonValue,
    };
  }

  async create(auth: AuthContext, body: unknown, request: FastifyRequest): Promise<SavedSearchDto> {
    const input = this.validateBody(body);
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      if (input.caseId !== undefined) {
        const found = await tx.case.findFirst({
          where: { id: input.caseId, tenantId: auth.tenantId },
          select: { id: true },
        });
        if (!found) throw new NotFoundException();
      }
      const created = await tx.savedSearch.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          caseId: input.caseId ?? null,
          queryText: input.queryText,
          syntax: input.syntax,
          queryAst: input.queryAst,
          createdById: auth.userId,
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'saved_search.created',
        targetType: 'saved_search',
        targetId: created.id,
        summary: { name: input.name, queryLength: input.queryText.length },
        request,
      });
      return created;
    });
    return toDto(row);
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: SavedSearchDto[]; nextCursor: string | null }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.savedSearch.findMany({
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

  async get(auth: AuthContext, id: string): Promise<SavedSearchDto> {
    const row = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.savedSearch.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!row) throw new NotFoundException();
    return toDto(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<SavedSearchDto> {
    const { version } = zodValidate(updateSchema, body);
    const input = this.validateBody(body);
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const existing = await tx.savedSearch.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException();
      // Optimistic concurrency: the update only lands on the expected version.
      const updated = await tx.savedSearch.updateMany({
        where: { id, tenantId: auth.tenantId, version },
        data: {
          name: input.name,
          caseId: input.caseId ?? null,
          queryText: input.queryText,
          syntax: input.syntax,
          queryAst: input.queryAst,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException('saved search was modified concurrently; reload and retry');
      }
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'saved_search.updated',
        targetType: 'saved_search',
        targetId: id,
        summary: { name: input.name },
        request,
      });
      return tx.savedSearch.findFirstOrThrow({ where: { id, tenantId: auth.tenantId } });
    });
    return toDto(row);
  }

  async remove(auth: AuthContext, id: string, request: FastifyRequest): Promise<{ ok: true }> {
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const existing = await tx.savedSearch.findFirst({
        where: { id, tenantId: auth.tenantId },
        select: { id: true, name: true },
      });
      if (!existing) throw new NotFoundException();
      await tx.savedSearch.delete({ where: { id } });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'saved_search.deleted',
        targetType: 'saved_search',
        targetId: id,
        summary: { name: existing.name },
        request,
      });
    });
    return { ok: true };
  }
}
