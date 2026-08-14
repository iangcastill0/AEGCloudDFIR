import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CaseStatus, TenantRole } from '@aeg-clouddfir/database';
import {
  caseMemberListResponse,
  caseTagListResponse,
  caseNoteListResponse,
  caseNote,
} from '@aeg-clouddfir/contracts';
import { CasesService } from './cases.service.js';
import type { SelectionService } from '../search/selection.service.js';
import {
  CASE_ID,
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
    const { service } = notesService([noteRow], [
      { id: 'u1', email: 'a@test.local', displayName: 'A Reviewer' },
    ]);
    const page = await service.notes(auth, CASE_ID, { limit: 10 });
    const parsed = caseNoteListResponse.safeParse(page);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(page.items[0]?.authorDisplay).toBe('A Reviewer');
  });

  it('falls back to the email when a user has no display name', async () => {
    const { service } = notesService([noteRow], [
      { id: 'u1', email: 'a@test.local', displayName: '' },
    ]);
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
