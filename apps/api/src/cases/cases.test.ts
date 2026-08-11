import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CaseStatus, TenantRole } from '@evidencevault/database';
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
