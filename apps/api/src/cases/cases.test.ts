import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CaseStatus, TenantRole } from '@aeg-clouddfir/database';
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

describe('CasesService.members', () => {
  it('joins the identity behind each membership, not just its id', async () => {
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => ({ id: CASE_ID })) },
      caseMember: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          {
            membershipId: 'm-1',
            role: 'reviewer',
            createdAt: new Date('2026-08-14T11:58:00.000Z'),
            membership: { user: { email: 'a@test.local', displayName: 'A Reviewer' } },
          },
        ]),
      },
    });

    const result = await service.members(auth, CASE_ID);
    // A UUID list tells a reviewer nothing about who can see a matter.
    expect(result.items[0]).toEqual({
      membershipId: 'm-1',
      role: 'reviewer',
      email: 'a@test.local',
      displayName: 'A Reviewer',
      addedAt: '2026-08-14T11:58:00.000Z',
    });
  });

  it('404s for a case in another tenant', async () => {
    const { service } = makeService({ case: { findFirst: vi.fn(async () => null) } });
    await expect(service.members(auth, CASE_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('CasesService notes', () => {
  function notesService(rows: Record<string, unknown>[] = []) {
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
    });
    return { service, audit, create };
  }

  it('lists notes oldest first, so they read as a running commentary', async () => {
    const { service } = notesService([
      { id: 'n1', text: 'first', authorId: 'u1', createdAt: new Date('2026-08-14T10:00:00.000Z') },
    ]);
    const result = await service.notes(auth, CASE_ID);
    expect(result.items[0]).toMatchObject({ id: 'n1', text: 'first' });
  });

  it('creates a note attributed to the author and audits it', async () => {
    const { service, audit, create } = notesService();
    const note = await service.addNote(auth, CASE_ID, { text: 'reviewed for privilege' }, fakeRequest());

    expect(note.text).toBe('reviewed for privilege');
    expect((create.mock.calls[0]![0] as { data: { authorId: unknown } }).data.authorId).toBe(
      auth.userId,
    );
    // Commentary on a matter may later be read as part of the record, so who
    // wrote it and when must be attributable rather than inferred from a row.
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'case.note_added' }),
    );
  });

  it('rejects an empty or whitespace-only note', async () => {
    const { service } = notesService();
    await expect(service.addNote(auth, CASE_ID, { text: '   ' }, fakeRequest())).rejects.toThrow();
    await expect(service.addNote(auth, CASE_ID, { text: '' }, fakeRequest())).rejects.toThrow();
  });

  it('rejects a note beyond the length bound', async () => {
    const { service } = notesService();
    await expect(
      service.addNote(auth, CASE_ID, { text: 'x'.repeat(8001) }, fakeRequest()),
    ).rejects.toThrow();
  });

  it('404s before writing when the case is not visible', async () => {
    const create = vi.fn();
    const { service } = makeService({
      case: { findFirst: vi.fn(async () => null) },
      caseNote: { create },
    });
    await expect(service.addNote(auth, CASE_ID, { text: 'x' }, fakeRequest())).rejects.toThrow(
      NotFoundException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
