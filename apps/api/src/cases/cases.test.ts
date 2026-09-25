import { describe, expect, it, vi, type Mock } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CaseStatus, TenantRole } from '@aeg-clouddfir/database';
import {
  caseActivityListResponse,
  caseMemberListResponse,
  caseSummary,
  caseTagListResponse,
  caseNoteListResponse,
  caseNote,
} from '@aeg-clouddfir/contracts';
import { CasesService } from './cases.service.js';
import type { SelectionService } from '../search/selection.service.js';
import {
  CASE_ID,
  COLLECTION_ID,
  CUSTODIAN_ID,
  ITEM_A,
  ITEM_B,
  TAG_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.case_manager]);

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    tenantId: TENANT_ID,
    name: 'Matter 1',
    matterNumber: 'M-1',
    client: 'Acme',
    description: '',
    status: CaseStatus.open,
    legalHold: false,
    createdAt: new Date(),
    version: 1,
    ...overrides,
  };
}

function makeService(models: Record<string, unknown>, selection?: Partial<SelectionService>) {
  const audit = fakeAudit();
  const prisma = fakePrisma(models);
  const service = new CasesService(prisma, audit.service, (selection ?? {}) as SelectionService);
  // $transaction is a mock, so a test can count how many transactions the work
  // was split across — which is the difference the large-collection fix made.
  return { service, audit, prisma: prisma as unknown as { $transaction: Mock } };
}

/** Cursor value the service starts from; sorts before every real uuid. */
const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

/**
 * A fake of the paged INSERT ... SELECT that files a collection into a case.
 *
 * The service calls $queryRaw as a tagged template, so the mock receives the
 * SQL fragments and then the interpolated values in order:
 * tenantId, collectionId, cursor, limit, caseId, addedById.
 */
function pagedInsert(total: number) {
  const ids = Array.from(
    { length: total },
    (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
  );
  // A Map, not findIndex: a linear scan per page is quadratic across the walk,
  // which is how an earlier test in this repo took nine seconds and timed out.
  const indexById = new Map(ids.map((id, i) => [id, i]));

  const queryRaw = vi.fn(async (_sql: unknown, ...values: unknown[]) => {
    const cursor = values[2] as string;
    const take = values[3] as number;
    const start = cursor === UUID_ZERO ? 0 : (indexById.get(cursor) ?? -1) + 1;
    const page = ids.slice(start, start + take);
    return [
      {
        inserted: page.length,
        scanned: page.length,
        lastId: page.length > 0 ? (page[page.length - 1] ?? null) : null,
      },
    ];
  });

  return {
    queryRaw,
    ids,
    /** The SQL text of call `n`, fragments joined. */
    sqlOf: (n: number) => ((queryRaw.mock.calls[n]?.[0] ?? []) as unknown as string[]).join('?'),
    /** The interpolated values of call `n`. */
    valuesOf: (n: number) => queryRaw.mock.calls[n]?.slice(1) ?? [],
  };
}

describe('CasesService.addItems', () => {
  it('adds every item carrying the tag (reference-only) and audits the counts', async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const { service, audit } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      tag: { findFirst: vi.fn(async () => ({ id: TAG_ID })) },
      tagAssignment: {
        findMany: vi.fn(async () => [{ evidenceItemId: ITEM_A }, { evidenceItemId: ITEM_B }]),
      },
      caseItem: { createMany },
      // Adding to a case re-indexes the items; see the re-index test below.
      evidenceItem: {
        findMany: vi.fn(async () => [
          { id: ITEM_A, version: 1 },
          { id: ITEM_B, version: 1 },
        ]),
      },
      outboxEvent: {
        createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      },
    });

    const result = await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'tag', tagId: TAG_ID }, includeFamilies: false },
      fakeRequest(),
    );
    expect(result.added).toBe(2);

    const rows = (
      createMany.mock.calls[0]?.[0] as {
        data: { evidenceItemId: string; addedVia: string }[];
      }
    ).data;
    expect(rows.map((row) => row.evidenceItemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(rows[0]?.addedVia).toBe('tag');

    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'case.items_added',
        summary: expect.objectContaining({ sourceKind: 'tag', added: 2 }),
      }),
    );
  });

  it('adds everything in a collection without loading its ids', async () => {
    // "Add from a collection" is how a case starts: you collect first, then
    // scope a matter to what came back.
    //
    // The ids deliberately never reach this process. A collection has no upper
    // bound — the largest here holds 434,910 items — so membership is written
    // by one INSERT ... SELECT per page instead.
    const findMany = vi.fn(async () => []);
    const { service, audit } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      evidenceItem: { findMany },
      outboxEvent: {
        createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      },
      $queryRaw: pagedInsert(2).queryRaw,
    });

    const result = await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
      fakeRequest(),
    );

    expect(result).toEqual({ requested: 2, added: 2 });
    expect(findMany).not.toHaveBeenCalled();
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: expect.objectContaining({ sourceKind: 'collection', added: 2 }),
      }),
    );
  });

  it('scopes the insert to the tenant as well as the collection', async () => {
    // A collection id from another tenant must not widen the query. RLS is the
    // real boundary, but raw SQL bypasses Prisma's own filtering, so the
    // predicate is stated explicitly too.
    const paged = pagedInsert(2);
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
      $queryRaw: paged.queryRaw,
    });

    await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
      fakeRequest(),
    );

    const sql = paged.sqlOf(0);
    expect(sql).toContain('e."tenantId" =');
    expect(sql).toContain('e."collectionId" =');
    expect(paged.valuesOf(0).slice(0, 2)).toEqual([TENANT_ID, COLLECTION_ID]);
  });

  it('skips duplicates so a half-finished add is completed by running it again', async () => {
    const paged = pagedInsert(2);
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
      $queryRaw: paged.queryRaw,
    });

    await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
      fakeRequest(),
    );

    expect(paged.sqlOf(0)).toContain('ON CONFLICT ("caseId", "evidenceItemId") DO NOTHING');
  });

  it('404s for a collection in another tenant, rather than adding nothing quietly', async () => {
    // Silently adding zero items would look identical to an empty collection.
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      service.addItems(
        auth,
        CASE_ID,
        { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
        fakeRequest(),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('reports zero for an empty collection without failing', async () => {
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
      // $queryRaw defaults to no rows, which is what an empty collection reads.
    });
    const result = await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
      fakeRequest(),
    );
    expect(result).toEqual({ requested: 0, added: 0 });
  });

  it('404s for a case that does not exist in this tenant', async () => {
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => null) },
    });
    await expect(
      service.addItems(
        auth,
        CASE_ID,
        { source: { kind: 'tag', tagId: TAG_ID }, includeFamilies: false },
        fakeRequest(),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('re-indexes every added item, so the case filter in search can find them', async () => {
    // Case membership lives in the search document as `caseIds`. Without this
    // the items are in the case in the database and the case filter in Review
    // returns nothing at all.
    const outboxCreateMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      evidenceItem: {
        findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
          (args.where.id?.in ?? [ITEM_A, ITEM_B]).map((id: string) => ({ id, version: 2 })),
        ),
      },
      caseItem: {
        createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      },
      outboxEvent: { createMany: outboxCreateMany },
    });

    await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'items', evidenceItemIds: [ITEM_A, ITEM_B] }, includeFamilies: false },
      fakeRequest(),
    );

    const rows = (
      outboxCreateMany.mock.calls[0]?.[0] as {
        data: { topic: string; payload: Record<string, unknown> }[];
      }
    ).data;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.topic).toBe('search.index');
    expect(rows.map((r) => r.payload.evidenceItemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
  });
});

describe('CasesService.summary', () => {
  function grouped(rows: Record<string, unknown>[]) {
    return vi.fn(async () => rows);
  }

  it('reports totals, sources, collections and custodians by name', async () => {
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      caseItem: {
        groupBy: grouped([
          { addedVia: 'collection', _count: { _all: 6 } },
          { addedVia: 'tag', _count: { _all: 2 } },
        ]),
      },
      evidenceItem: {
        groupBy: vi
          .fn()
          // kind, then collectionId, then custodianId — in the order the service asks.
          .mockResolvedValueOnce([
            { kind: 'email', _count: { _all: 7 } },
            { kind: 'container', _count: { _all: 1 } },
          ])
          .mockResolvedValueOnce([{ collectionId: COLLECTION_ID, _count: { _all: 8 } }])
          .mockResolvedValueOnce([{ custodianId: CUSTODIAN_ID, _count: { _all: 8 } }]),
        aggregate: vi.fn(async () => ({
          _min: { primaryDate: new Date('2026-01-02T00:00:00Z') },
          _max: { primaryDate: new Date('2026-08-01T00:00:00Z') },
        })),
      },
      collection: { findMany: vi.fn(async () => [{ id: COLLECTION_ID, name: 'testing-pst' }]) },
      custodian: { findMany: vi.fn(async () => [{ id: CUSTODIAN_ID, email: 'test@test.com' }]) },
      caseNote: { count: vi.fn(async () => 3) },
      caseMember: { count: vi.fn(async () => 2) },
    });

    const result = await service.summary(auth, CASE_ID);

    expect(result.itemCount).toBe(8);
    expect(result.bySource).toEqual([
      { addedVia: 'collection', count: 6 },
      { addedVia: 'tag', count: 2 },
    ]);
    expect(result.byKind).toEqual([
      { kind: 'email', count: 7 },
      { kind: 'container', count: 1 },
    ]);
    // Named, not an id: an id tells a reviewer nothing about the acquisition.
    expect(result.collections).toEqual([{ id: COLLECTION_ID, name: 'testing-pst', count: 8 }]);
    expect(result.custodians).toEqual([{ id: CUSTODIAN_ID, email: 'test@test.com', count: 8 }]);
    expect(result.earliestItemDate).toBe('2026-01-02T00:00:00.000Z');
    expect(result.latestItemDate).toBe('2026-08-01T00:00:00.000Z');
    expect(result.noteCount).toBe(3);
    expect(caseSummary.safeParse(result).success).toBe(true);
  });

  it('says so when a collection has been deleted, rather than dropping its items', async () => {
    // The items still belong to the case; hiding them would make the totals lie.
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      caseItem: { groupBy: vi.fn(async () => [{ addedVia: 'collection', _count: { _all: 4 } }]) },
      evidenceItem: {
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([{ kind: 'email', _count: { _all: 4 } }])
          .mockResolvedValueOnce([{ collectionId: COLLECTION_ID, _count: { _all: 4 } }])
          .mockResolvedValueOnce([]),
        aggregate: vi.fn(async () => ({
          _min: { primaryDate: null },
          _max: { primaryDate: null },
        })),
      },
      collection: { findMany: vi.fn(async () => []) },
      custodian: { findMany: vi.fn(async () => []) },
      caseNote: { count: vi.fn(async () => 0) },
      caseMember: { count: vi.fn(async () => 0) },
    });

    const result = await service.summary(auth, CASE_ID);
    expect(result.collections).toEqual([
      { id: COLLECTION_ID, name: '(deleted collection)', count: 4 },
    ]);
    expect(result.earliestItemDate).toBeNull();
  });

  it('404s for a case in another tenant', async () => {
    const { service } = makeService({ case: { findFirst: vi.fn(async () => null) } });
    await expect(service.summary(auth, CASE_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('CasesService.activity', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: 'ev-1',
    sequence: 41n,
    action: 'case.items_added',
    actorDisplay: 'Ian Castillo',
    occurredAt: new Date('2026-08-20T18:00:00Z'),
    summary: { added: 6, requested: 8, sourceKind: 'collection' },
    ...over,
  });

  it('returns this case history in plain language, newest first', async () => {
    const findMany = vi.fn(async () => [event()]);
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      auditEvent: { findMany },
    });

    const result = await service.activity(auth, CASE_ID, { limit: 20 });

    expect(result.items[0]).toMatchObject({
      action: 'case.items_added',
      actorDisplay: 'Ian Castillo',
      detail: '6 items added from a collection (2 already in the case)',
      // BigInt cannot survive JSON; the contract expects a string.
      sequence: '41',
    });
    // Scoped to THIS case, and to the tenant, not a text search over summaries.
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: TENANT_ID, targetType: 'case', targetId: CASE_ID },
      orderBy: { sequence: 'desc' },
    });
    expect(caseActivityListResponse.safeParse(result).success).toBe(true);
  });

  it('pages with a cursor and reports whether more remain', async () => {
    const rows = [event({ id: 'a' }), event({ id: 'b' }), event({ id: 'c' })];
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      auditEvent: { findMany: vi.fn(async () => rows) },
    });
    const result = await service.activity(auth, CASE_ID, { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('b');
  });

  it('404s for a case in another tenant', async () => {
    const { service } = makeService({ case: { findFirst: vi.fn(async () => null) } });
    await expect(service.activity(auth, CASE_ID, { limit: 20 })).rejects.toThrow(NotFoundException);
  });
});

describe('CasesService.setHold', () => {
  it('flips legal hold and audits case.hold_changed with the reason', async () => {
    const update = vi.fn(async () => caseRow({ legalHold: true }));
    const { service, audit } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()), update },
    });

    const result = await service.setHold(
      auth,
      CASE_ID,
      { enabled: true, reason: 'litigation hold for matter 1' },
      fakeRequest(),
    );
    expect(result.legalHold).toBe(true);

    const updateArgs = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArgs.data.legalHold).toBe(true);
    expect(updateArgs.data.legalHoldSetById).toBe(auth.userId);

    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'case.hold_changed',
        summary: { enabled: true, reason: 'litigation hold for matter 1' },
      }),
    );
  });
});

describe('CasesService case-restricted visibility', () => {
  it('read_only non-members get 404 for the case', async () => {
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      caseMember: { count: vi.fn(async () => 0) },
    });
    await expect(service.get(makeAuth([TenantRole.read_only]), CASE_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

/**
 * These validate the service's responses against the SAME schemas the web
 * client parses with. Without that, a shape mismatch compiles cleanly on both
 * sides and only fails in the browser — which is exactly how members shipped
 * returning `role` where the client wanted `roles`, and no `nextCursor` at all.
 */
describe('CasesService.members — matches the client contract', () => {
  function membersService(rows: Record<string, unknown>[]) {
    return makeService({
      case: { findFirst: vi.fn(async () => ({ id: CASE_ID })) },
      caseMember: { count: vi.fn(async () => 1), findMany: vi.fn(async () => rows) },
    }).service;
  }

  const row = {
    id: 'cm-1',
    membershipId: 'm-1',
    role: 'reviewer',
    createdAt: new Date('2026-08-14T11:58:00.000Z'),
    membership: { user: { email: 'a@test.local', displayName: 'A Reviewer' } },
  };

  it('parses against caseMemberListResponse', async () => {
    const page = await membersService([row]).members(auth, CASE_ID, { limit: 10 });
    const parsed = caseMemberListResponse.safeParse(page);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('joins the identity behind the membership and exposes roles as an array', async () => {
    const page = await membersService([row]).members(auth, CASE_ID, { limit: 10 });
    expect(page.items[0]).toEqual({
      membershipId: 'm-1',
      email: 'a@test.local',
      displayName: 'A Reviewer',
      roles: ['reviewer'],
    });
  });

  it('returns nextCursor null on the last page, never undefined', async () => {
    // undefined here is what broke the client: the contract requires a string
    // or null, and an absent key fails validation.
    const page = await membersService([row]).members(auth, CASE_ID, { limit: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it('returns a cursor when more members remain', async () => {
    const many = [row, { ...row, id: 'cm-2' }, { ...row, id: 'cm-3' }];
    const page = await membersService(many).members(auth, CASE_ID, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('cm-2');
  });

  it('404s for a case in another tenant', async () => {
    const service = makeService({ case: { findFirst: vi.fn(async () => null) } }).service;
    await expect(service.members(auth, CASE_ID, { limit: 10 })).rejects.toThrow(NotFoundException);
  });
});

describe('CasesService notes — matches the client contract', () => {
  function notesService(rows: Record<string, unknown>[], users: Record<string, unknown>[] = []) {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'note-1',
      text: args.data['text'],
      authorId: args.data['authorId'],
      createdAt: new Date('2026-08-14T12:00:00.000Z'),
    }));
    const { service, audit } = makeService({
      case: { findFirst: vi.fn(async () => ({ id: CASE_ID })) },
      caseMember: { count: vi.fn(async () => 1) },
      caseNote: { findMany: vi.fn(async () => rows), create },
      user: { findMany: vi.fn(async () => users) },
    });
    return { service, audit, create };
  }

  const noteRow = {
    id: 'n1',
    text: 'reviewed for privilege',
    authorId: 'u1',
    createdAt: new Date('2026-08-14T10:00:00.000Z'),
  };

  it('parses against caseNoteListResponse', async () => {
    const { service } = notesService(
      [noteRow],
      [{ id: 'u1', email: 'a@test.local', displayName: 'A Reviewer' }],
    );
    const page = await service.notes(auth, CASE_ID, { limit: 10 });
    const parsed = caseNoteListResponse.safeParse(page);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(page.items[0]?.authorDisplay).toBe('A Reviewer');
  });

  it('falls back to the email when a user has no display name', async () => {
    const { service } = notesService(
      [noteRow],
      [{ id: 'u1', email: 'a@test.local', displayName: '' }],
    );
    const page = await service.notes(auth, CASE_ID, { limit: 10 });
    expect(page.items[0]?.authorDisplay).toBe('a@test.local');
  });

  it('tolerates a note whose author no longer resolves', async () => {
    // A deleted user must not break reading a matter's history.
    const { service } = notesService([noteRow], []);
    const page = await service.notes(auth, CASE_ID, { limit: 10 });
    expect(page.items[0]?.authorDisplay).toBe('');
    expect(caseNoteListResponse.safeParse(page).success).toBe(true);
  });

  it('a created note parses against the note schema and is audited', async () => {
    const { service, audit, create } = notesService([]);
    const note = await service.addNote(auth, CASE_ID, { text: 'privileged' }, fakeRequest());
    expect(caseNote.safeParse(note).success).toBe(true);
    expect((create.mock.calls[0]![0] as { data: { authorId: unknown } }).data.authorId).toBe(
      auth.userId,
    );
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'case.note_added' }),
    );
  });

  it.each(['', '   '])('rejects a blank note (%j)', async (text) => {
    const { service } = notesService([]);
    await expect(service.addNote(auth, CASE_ID, { text }, fakeRequest())).rejects.toThrow();
  });

  it('rejects a note beyond the length bound', async () => {
    const { service } = notesService([]);
    await expect(
      service.addNote(auth, CASE_ID, { text: 'x'.repeat(8001) }, fakeRequest()),
    ).rejects.toThrow();
  });

  it('404s before writing when the case is not visible', async () => {
    const create = vi.fn();
    const service = makeService({
      case: { findFirst: vi.fn(async () => null) },
      caseNote: { create },
    }).service;
    await expect(service.addNote(auth, CASE_ID, { text: 'x' }, fakeRequest())).rejects.toThrow(
      NotFoundException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('CasesService.tags — only tags present in the matter', () => {
  function tagService(caseItems: { evidenceItemId: string }[], assignments: unknown[]) {
    return makeService({
      case: { findFirst: vi.fn(async () => ({ id: CASE_ID })) },
      caseMember: { count: vi.fn(async () => 1) },
      caseItem: { findMany: vi.fn(async () => caseItems) },
      tagAssignment: { findMany: vi.fn(async () => assignments) },
    }).service;
  }
  const hot = { id: 't-hot', name: 'Hot', color: '#f00' };
  const priv = { id: 't-priv', name: 'Privileged', color: '#00f' };

  it('parses against the contract and counts items per tag', async () => {
    const page = await tagService(
      [{ evidenceItemId: ITEM_A }, { evidenceItemId: 'i-2' }],
      [
        { tagId: 't-hot', tag: hot },
        { tagId: 't-hot', tag: hot },
        { tagId: 't-priv', tag: priv },
      ],
    ).tags(auth, CASE_ID);

    expect(caseTagListResponse.safeParse(page).success).toBe(true);
    // The count matters: a tag on one document is a very different production
    // from the same tag on five hundred.
    expect(page.items).toEqual([
      { id: 't-hot', name: 'Hot', color: '#f00', itemCount: 2 },
      { id: 't-priv', name: 'Privileged', color: '#00f', itemCount: 1 },
    ]);
  });

  it('sorts by name so the list is stable between requests', async () => {
    const page = await tagService(
      [{ evidenceItemId: ITEM_A }],
      [
        { tagId: 't-priv', tag: priv },
        { tagId: 't-hot', tag: hot },
      ],
    ).tags(auth, CASE_ID);
    expect(page.items.map((t) => t.name)).toEqual(['Hot', 'Privileged']);
  });

  it('returns nothing for a case with no items, without querying assignments', async () => {
    const assignmentQuery = vi.fn(async () => []);
    const service = makeService({
      case: { findFirst: vi.fn(async () => ({ id: CASE_ID })) },
      caseMember: { count: vi.fn(async () => 1) },
      caseItem: { findMany: vi.fn(async () => []) },
      tagAssignment: { findMany: assignmentQuery },
    }).service;
    expect(await service.tags(auth, CASE_ID)).toEqual({ items: [] });
    // An IN () against an empty list is a pointless round trip.
    expect(assignmentQuery).not.toHaveBeenCalled();
  });

  it('returns nothing when the case has items but none are tagged', async () => {
    const page = await tagService([{ evidenceItemId: ITEM_A }], []).tags(auth, CASE_ID);
    expect(page.items).toEqual([]);
  });

  it('404s for a case in another tenant', async () => {
    const service = makeService({ case: { findFirst: vi.fn(async () => null) } }).service;
    await expect(service.tags(auth, CASE_ID)).rejects.toThrow(NotFoundException);
  });
});

const COLLECTION_ID = '00000000-0000-4000-8000-0000000000c1';

describe('CasesService.addItems on a whole collection', () => {
  /**
   * Two production failures, one after the other.
   *
   * First: adding a 434,910-item collection ran the entire operation — family
   * expansion, membership inserts, re-index rows, ~1,400 round trips — inside
   * ONE transaction and died at 30,129 ms against the 30-second limit.
   *
   * Then, with that fixed, the add succeeded but Review still could not find
   * the case for 10-25 hours: it queued one re-index job per item, and a
   * re-index rebuilds the whole document (a read with eleven nested includes
   * plus a download of the item's text from object storage) to append one
   * string to one field.
   *
   * So the shape asserted here is: many short transactions, no ids in this
   * process, and exactly ONE job.
   */
  function bigCollection(total: number) {
    const paged = pagedInsert(total);
    const outboxCreateMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const evidenceFindMany = vi.fn(async () => []);
    const relationshipFindMany = vi.fn(async () => []);
    const { service, audit, prisma } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      evidenceItem: { findMany: evidenceFindMany },
      evidenceRelationship: { findMany: relationshipFindMany },
      outboxEvent: { createMany: outboxCreateMany },
      $queryRaw: paged.queryRaw,
    });
    return {
      service,
      audit,
      prisma,
      paged,
      outboxCreateMany,
      evidenceFindMany,
      relationshipFindMany,
    };
  }

  function addCollection(service: CasesService, includeFamilies = false) {
    return service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies },
      fakeRequest(),
    );
  }

  it('files a large collection and reports the counts', async () => {
    const { service } = bigCollection(434_910);
    expect(await addCollection(service)).toEqual({ requested: 434_910, added: 434_910 });
  }, 20_000);

  it('queues ONE job, not one per item', async () => {
    // The 10-25 hours. 434,910 re-index jobs, each rebuilding a whole document
    // from the database and object storage, to add one case id.
    const { service, outboxCreateMany } = bigCollection(434_910);
    await addCollection(service);

    const rows = outboxCreateMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { topic: string }[] }).data,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topic).toBe('search.case-collection');
  }, 20_000);

  it('carries the case and collection to the worker, not a list of items', async () => {
    const { service, outboxCreateMany } = bigCollection(1_000);
    await addCollection(service);

    const row = (outboxCreateMany.mock.calls[0]?.[0] as { data: { payload: unknown }[] }).data[0];
    expect(row?.payload).toEqual({
      tenantId: TENANT_ID,
      caseId: CASE_ID,
      collectionId: COLLECTION_ID,
    });
  });

  it('gives the job a fresh dedup key every time', async () => {
    // Dispatched outbox rows are KEPT and (topic, dedupKey) is unique, so a key
    // built from the case and collection alone works exactly once ever — the
    // second add of the same pair would be dropped by skipDuplicates and the
    // index would never hear about it.
    const first = bigCollection(10);
    await addCollection(first.service);
    const second = bigCollection(10);
    await addCollection(second.service);

    const keyOf = (m: typeof first.outboxCreateMany) =>
      (m.mock.calls[0]?.[0] as { data: { dedupKey: string }[] }).data[0]?.dedupKey;

    expect(keyOf(first.outboxCreateMany)).not.toBe(keyOf(second.outboxCreateMany));
    expect(keyOf(first.outboxCreateMany)).toContain(`case-collection:${CASE_ID}:${COLLECTION_ID}:`);
  });

  it('does NOT hold one transaction open for the whole add', async () => {
    // The original failure: ~1,400 round trips inside a single
    // withTenantContext, against a 30-second limit. A fake cannot reproduce a
    // real timeout, so this asserts the structure instead.
    const { service, prisma } = bigCollection(434_910);
    await addCollection(service);
    expect(prisma.$transaction.mock.calls.length).toBeGreaterThan(10);
  }, 20_000);

  it('never asks for more than one page of rows at a time', async () => {
    const { service, paged } = bigCollection(434_910);
    await addCollection(service);

    expect(paged.queryRaw.mock.calls.length).toBeGreaterThan(1);
    for (const call of paged.queryRaw.mock.calls) {
      expect(call[4] as number).toBeLessThanOrEqual(25_000);
    }
  }, 20_000);

  it('pages with a cursor rather than an offset', async () => {
    // OFFSET makes the database walk every skipped row, so the last page of a
    // 434,910-item collection would be the slowest — the opposite of what is
    // needed.
    const { service, paged } = bigCollection(60_000);
    await addCollection(service);

    expect(paged.valuesOf(0)[2]).toBe(UUID_ZERO);
    expect(paged.valuesOf(1)[2]).toBe(paged.ids[24_999]);
    expect(paged.valuesOf(2)[2]).toBe(paged.ids[49_999]);
  }, 20_000);

  it('stops on a short page instead of one pointless extra query', async () => {
    const { service, paged } = bigCollection(30_000);
    await addCollection(service);
    expect(paged.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('never loads the collection ids into this process', async () => {
    // The ids are the thing that does not scale. Reading 434,910 of them to
    // hand straight back to the database is the cost this path exists to avoid.
    const { service, evidenceFindMany } = bigCollection(434_910);
    await addCollection(service);
    expect(evidenceFindMany).not.toHaveBeenCalled();
  }, 20_000);

  it('skips family expansion even when the caller asks for it', async () => {
    // Not a shortcut: a collection already holds its own attachments as items
    // in their own right. Measured on the 434,910-item collection, expanding
    // families added exactly zero ids — at a cost of 87 extra round trips.
    const { service, relationshipFindMany } = bigCollection(1_000);
    await addCollection(service, true);
    expect(relationshipFindMany).not.toHaveBeenCalled();
  });

  it('writes the membership rows before queueing the job', async () => {
    // The worker stamps documents from the collection id, but anything
    // re-indexed later rebuilds caseIds from these rows. If the job ran first
    // it could stamp a document that a concurrent re-index then overwrote with
    // a caseIds list that did not yet include this case.
    const order: string[] = [];
    const paged = pagedInsert(10);
    const queryRaw = vi.fn(async (...args: unknown[]) => {
      order.push('rows');
      return paged.queryRaw(...(args as Parameters<typeof paged.queryRaw>));
    });
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      outboxEvent: {
        createMany: vi.fn(async () => {
          order.push('job');
          return { count: 1 };
        }),
      },
      $queryRaw: queryRaw,
    });

    await addCollection(service);
    expect(order).toEqual(['rows', 'job']);
  });

  it('still audits the disclosure, with the collection it came from', async () => {
    const { service, audit } = bigCollection(1_000);
    await addCollection(service);

    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'case.items_added',
        summary: expect.objectContaining({
          sourceKind: 'collection',
          collectionId: COLLECTION_ID,
          requested: 1_000,
          added: 1_000,
        }),
      }),
    );
  });
});

describe('CasesService.items privilege', () => {
  function list(role: TenantRole) {
    const findMany = vi.fn(async () => []);
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      caseItem: { findMany },
    });
    return { service, findMany, role };
  }

  it('hides privileged items from a reviewer', async () => {
    const { service, findMany } = list(TenantRole.reviewer);
    await service.items(makeAuth([TenantRole.reviewer]), CASE_ID, { limit: 50 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          evidenceItem: { tagAssignments: { none: { tag: { isPrivileged: true } } } },
        }),
      }),
    );
  });

  it('leaves privileged items visible to a case manager', async () => {
    const { service, findMany } = list(TenantRole.case_manager);
    await service.items(makeAuth([TenantRole.case_manager]), CASE_ID, { limit: 50 });
    const where = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(where.where).not.toHaveProperty('evidenceItem');
  });
});
