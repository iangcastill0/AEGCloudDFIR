import { describe, expect, it, vi } from 'vitest';
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
  const service = new CasesService(
    fakePrisma(models),
    audit.service,
    (selection ?? {}) as SelectionService,
  );
  return { service, audit };
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

  it('adds everything in a collection, recording how it got there', async () => {
    // "Add from a collection" is how a case starts: you collect first, then scope
    // a matter to what came back. Doing it by tag first meant tagging thousands
    // of items just to reference them.
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const findMany = vi.fn(async () => [
      { id: ITEM_A, version: 1 },
      { id: ITEM_B, version: 1 },
    ]);
    const { service, audit } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      evidenceItem: { findMany },
      caseItem: { createMany },
      outboxEvent: {
        createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      },
    });

    const result = await service.addItems(
      auth,
      CASE_ID,
      { source: { kind: 'collection', collectionId: COLLECTION_ID }, includeFamilies: false },
      fakeRequest(),
    );

    expect(result).toEqual({ requested: 2, added: 2 });
    // Scoped to the collection AND the tenant: a collection id from another
    // tenant must not widen the query.
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenantId: TENANT_ID, collectionId: COLLECTION_ID },
    });
    const rows = (createMany.mock.calls[0]?.[0] as { data: { addedVia: string }[] }).data;
    expect(rows[0]?.addedVia).toBe('collection');
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: expect.objectContaining({ sourceKind: 'collection', added: 2 }),
      }),
    );
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
    const createMany = vi.fn(async () => ({ count: 0 }));
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => caseRow()) },
      collection: { findFirst: vi.fn(async () => ({ id: COLLECTION_ID })) },
      evidenceItem: { findMany: vi.fn(async () => []) },
      caseItem: { createMany },
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
