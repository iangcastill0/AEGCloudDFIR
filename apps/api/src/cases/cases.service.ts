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
import { describeCaseEvent } from './case-activity.js';
import { PRISMA } from '../common/tokens.js';
import type { CursorQuery } from '../common/pagination.js';
import { zodValidate } from '../common/zod-validate.js';
import { chunk, expandFamilies } from '../common/families.js';
import { enqueueReindex } from '../common/reindex.js';
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

interface CaseSummaryDto {
  itemCount: number;
  byKind: { kind: string; count: number }[];
  bySource: { addedVia: string; count: number }[];
  collections: { id: string; name: string; count: number }[];
  custodians: { id: string; email: string; count: number }[];
  earliestItemDate: string | null;
  latestItemDate: string | null;
  noteCount: number;
  memberCount: number;
}

interface CaseActivityDto {
  id: string;
  sequence: string;
  action: string;
  actorDisplay: string;
  occurredAt: string;
  detail: string;
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
    } else if (input.source.kind === 'collection') {
      // Resolved inside the transaction below: the collection has to be
      // checked against the tenant before any of its items are read.
      sourceIds = [];
      addedVia = 'collection';
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
      } else if (input.source.kind === 'collection') {
        const collection = await tx.collection.findFirst({
          where: { id: input.source.collectionId, tenantId: auth.tenantId },
          select: { id: true },
        });
        // 404 rather than an empty add: adding zero items silently would look
        // exactly like a collection that happened to be empty.
        if (!collection) throw new NotFoundException();
        const items = await tx.evidenceItem.findMany({
          where: { tenantId: auth.tenantId, collectionId: collection.id },
          select: { id: true },
        });
        sourceIds = items.map((item) => item.id);
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

      // The case filter in search reads `caseIds` from the index document, and
      // that document is built from database truth at index time — so a new
      // member of a case is invisible to search until the item is re-indexed.
      // Every requested id is re-indexed, not just the newly inserted ones, so
      // an item whose document is already stale is repaired by adding it again.
      await enqueueReindex(tx, auth.tenantId, finalIds, 'case');

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
   * cannot tell who has access to a matter. Shape matches the client's
   * caseMemberListResponse: `roles` is an array because a member may hold more
   * than one case role in future, and paginated so a large matter cannot return
   * an unbounded page.
   */
  async members(
    auth: AuthContext,
    id: string,
    page: CursorQuery,
  ): Promise<{
    items: { membershipId: string; email: string; displayName: string; roles: string[] }[];
    nextCursor: string | null;
  }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const rows = await tx.caseMember.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        include: { membership: { include: { user: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        ...(page.cursor ? { skip: 1, cursor: { id: page.cursor } } : {}),
      });
      const items = rows.slice(0, page.limit);
      return {
        items: items.map((row) => ({
          membershipId: row.membershipId,
          email: row.membership.user.email,
          displayName: row.membership.user.displayName,
          roles: [row.role],
        })),
        nextCursor: rows.length > page.limit ? (items[items.length - 1]?.id ?? null) : null,
      };
    });
  }

  /**
   * Case notes, oldest first: they read as a running commentary on the matter.
   *
   * Returns authorDisplay rather than an author id — a note attributed to a UUID
   * is useless when reading a matter's history. Users carry no RLS, so the
   * lookup is a plain query outside the tenant-scoped models.
   */
  async notes(
    auth: AuthContext,
    id: string,
    page: CursorQuery,
  ): Promise<{
    items: { id: string; authorDisplay: string; text: string; createdAt: string }[];
    nextCursor: string | null;
  }> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      return tx.caseNote.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        ...(page.cursor ? { skip: 1, cursor: { id: page.cursor } } : {}),
      });
    });
    const items = rows.slice(0, page.limit);
    const authors = await this.resolveAuthors(items.map((r) => r.authorId));
    return {
      items: items.map((row) => ({
        id: row.id,
        authorDisplay: row.authorId === null ? '' : (authors.get(row.authorId) ?? ''),
        text: row.text,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Tags actually present on this case's items.
   *
   * Distinct from the tenant's full tag list. A production is built from a
   * case, so offering every tag in the tenant invites selecting one that
   * matches nothing in the matter — producing an empty set, or worse, silently
   * narrowing a production the reviewer believed was complete.
   */
  /**
   * What the case holds, counted in the database.
   *
   * Aggregated with groupBy rather than by loading the rows: a case can
   * reference tens of thousands of items, and the page only needs the totals.
   * Collections and custodians are resolved to names, because an id tells a
   * reviewer nothing about which acquisition a case draws on.
   */
  async summary(auth: AuthContext, id: string): Promise<CaseSummaryDto> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const inThisCase = {
        tenantId: auth.tenantId,
        caseItems: { some: { caseId: id } },
      };

      const [bySourceRows, byKindRows, byCollection, byCustodian, span, noteCount, memberCount] =
        await Promise.all([
          tx.caseItem.groupBy({
            by: ['addedVia'],
            where: { tenantId: auth.tenantId, caseId: id },
            _count: { _all: true },
          }),
          tx.evidenceItem.groupBy({ by: ['kind'], where: inThisCase, _count: { _all: true } }),
          tx.evidenceItem.groupBy({
            by: ['collectionId'],
            where: inThisCase,
            _count: { _all: true },
          }),
          tx.evidenceItem.groupBy({
            by: ['custodianId'],
            where: inThisCase,
            _count: { _all: true },
          }),
          tx.evidenceItem.aggregate({
            where: inThisCase,
            _min: { primaryDate: true },
            _max: { primaryDate: true },
          }),
          tx.caseNote.count({ where: { tenantId: auth.tenantId, caseId: id } }),
          tx.caseMember.count({ where: { tenantId: auth.tenantId, caseId: id } }),
        ]);

      // Name the collections and custodians in one query each, not one per row.
      const collectionIds = byCollection
        .map((r) => r.collectionId)
        .filter((v): v is string => v !== null);
      const custodianIds = byCustodian
        .map((r) => r.custodianId)
        .filter((v): v is string => v !== null);
      const [collectionRows, custodianRows] = await Promise.all([
        collectionIds.length > 0
          ? tx.collection.findMany({
              where: { tenantId: auth.tenantId, id: { in: collectionIds } },
              select: { id: true, name: true },
            })
          : Promise.resolve([]),
        custodianIds.length > 0
          ? tx.custodian.findMany({
              where: { tenantId: auth.tenantId, id: { in: custodianIds } },
              select: { id: true, email: true },
            })
          : Promise.resolve([]),
      ]);
      const collectionName = new Map(collectionRows.map((c) => [c.id, c.name]));
      const custodianEmail = new Map(custodianRows.map((c) => [c.id, c.email]));

      const itemCount = bySourceRows.reduce((sum, r) => sum + r._count._all, 0);
      return {
        itemCount,
        byKind: byKindRows.map((r) => ({ kind: r.kind, count: r._count._all })),
        bySource: bySourceRows.map((r) => ({ addedVia: r.addedVia, count: r._count._all })),
        collections: byCollection
          .filter((r) => r.collectionId !== null)
          .map((r) => ({
            id: r.collectionId as string,
            // An item whose collection was deleted still belongs to the case;
            // say so rather than dropping it from the totals.
            name: collectionName.get(r.collectionId as string) ?? '(deleted collection)',
            count: r._count._all,
          })),
        custodians: byCustodian
          .filter((r) => r.custodianId !== null)
          .map((r) => ({
            id: r.custodianId as string,
            email: custodianEmail.get(r.custodianId as string) ?? '(unknown custodian)',
            count: r._count._all,
          })),
        earliestItemDate: span._min.primaryDate?.toISOString() ?? null,
        latestItemDate: span._max.primaryDate?.toISOString() ?? null,
        noteCount,
        memberCount,
      };
    });
  }

  /**
   * This case's own history, from the audit chain.
   *
   * Deliberately not /audit, which requires org_admin or auditor: someone working
   * a case needs to see what happened to it without being able to read every
   * event in the tenant. Every case action is written with targetType 'case' and
   * the case id, so the filter is exact rather than a text search.
   */
  async activity(
    auth: AuthContext,
    id: string,
    page: { limit: number; cursor?: string },
  ): Promise<{ items: CaseActivityDto[]; nextCursor: string | null }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const rows = await tx.auditEvent.findMany({
        where: { tenantId: auth.tenantId, targetType: 'case', targetId: id },
        orderBy: { sequence: 'desc' },
        take: page.limit + 1,
        ...(page.cursor !== undefined ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      });
      const slice = rows.slice(0, page.limit);
      const last = slice[slice.length - 1];
      return {
        items: slice.map((row) => ({
          id: row.id,
          // BigInt: JSON cannot carry it, and the contract expects a string.
          sequence: String(row.sequence),
          action: row.action,
          actorDisplay: row.actorDisplay,
          occurredAt: row.occurredAt.toISOString(),
          detail: describeCaseEvent(row.action, row.summary),
        })),
        nextCursor: rows.length > page.limit && last ? last.id : null,
      };
    });
  }

  async tags(
    auth: AuthContext,
    id: string,
  ): Promise<{ items: { id: string; name: string; color: string; itemCount: number }[] }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireCase(tx, auth, id);
      const caseItems = await tx.caseItem.findMany({
        where: { tenantId: auth.tenantId, caseId: id },
        select: { evidenceItemId: true },
      });
      if (caseItems.length === 0) return { items: [] };

      const assignments = await tx.tagAssignment.findMany({
        where: {
          tenantId: auth.tenantId,
          evidenceItemId: { in: caseItems.map((c) => c.evidenceItemId) },
        },
        include: { tag: true },
      });

      // Count per tag so a reviewer can see how much of the matter each covers;
      // a tag on one document is a very different production from one on 500.
      const byTag = new Map<
        string,
        { id: string; name: string; color: string; itemCount: number }
      >();
      for (const a of assignments) {
        const existing = byTag.get(a.tagId);
        if (existing) existing.itemCount += 1;
        else {
          byTag.set(a.tagId, {
            id: a.tag.id,
            name: a.tag.name,
            color: a.tag.color,
            itemCount: 1,
          });
        }
      }
      return {
        items: [...byTag.values()].sort((x, y) => x.name.localeCompare(y.name)),
      };
    });
  }

  /** Display names for note authors, by user id. Empty when unknown. */
  private async resolveAuthors(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => i !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true, displayName: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName !== '' ? u.displayName : u.email]));
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
  ): Promise<{ id: string; authorDisplay: string; text: string; createdAt: string }> {
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
        // The author is the caller, so no lookup is needed here.
        authorDisplay: auth.actorDisplay,
        text: note.text,
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
