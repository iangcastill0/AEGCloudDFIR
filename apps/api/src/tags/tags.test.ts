import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { TagFamilyBehavior, TenantRole } from '@evidencevault/database';
import { TagsService } from './tags.service.js';
import {
  ITEM_A,
  ITEM_B,
  ITEM_C,
  TAG_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
} from '../testing/mocks.js';

const auth = makeAuth([TenantRole.case_manager]);

function makeService(models: Record<string, unknown>) {
  const audit = fakeAudit();
  const service = new TagsService(fakePrisma(models), audit.service);
  return { service, audit };
}

function tagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TAG_ID,
    tenantId: TENANT_ID,
    name: 'Hot',
    color: '#ff0000',
    description: '',
    isPrivileged: false,
    isConfidential: false,
    isHidden: false,
    familyBehavior: TagFamilyBehavior.none,
    createdAt: new Date(),
    version: 1,
    ...overrides,
  };
}

describe('TagsService.bulk', () => {
  it('apply_to_family expands to family members via relationships (both directions)', async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const { service } = makeService({
      tag: {
        findFirst: vi.fn(async () => tagRow({ familyBehavior: TagFamilyBehavior.apply_to_family })),
      },
      evidenceItem: {
        findMany: vi.fn(async (args: { where?: { id?: { in: string[] } }; select: unknown }) =>
          (args.where?.id?.in ?? [ITEM_A]).map((id: string) => ({ id, version: 1 })),
        ),
      },
      evidenceRelationship: {
        findMany: vi.fn(async () => [
          { parentId: ITEM_A, childId: ITEM_B }, // child of the requested item
          { parentId: ITEM_C, childId: ITEM_A }, // parent of the requested item
        ]),
      },
      tagAssignment: { createMany },
      outboxEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
    });

    const result = await service.bulk(
      auth,
      { tagId: TAG_ID, evidenceItemIds: [ITEM_A], action: 'apply' },
      fakeRequest(),
    );
    expect(result.requested).toBe(1);
    expect(result.expanded).toBe(3);

    const rows = (createMany.mock.calls[0]?.[0] as { data: { evidenceItemId: string }[] }).data;
    const ids = rows.map((row) => row.evidenceItemId).sort();
    expect(ids).toEqual([ITEM_A, ITEM_B, ITEM_C].sort());
  });

  it('chunks bulk work into batches of 500 and enqueues search re-index events', async () => {
    const manyIds = Array.from({ length: 1200 }, (_, i) => {
      const hex = i.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${hex}`;
    });
    const assignmentCreateMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const outboxCreateMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const { service } = makeService({
      tag: { findFirst: vi.fn(async () => tagRow()) },
      evidenceItem: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id: string) => ({ id, version: 3 })),
        ),
      },
      tagAssignment: { createMany: assignmentCreateMany },
      outboxEvent: { createMany: outboxCreateMany },
    });

    const result = await service.bulk(
      auth,
      { tagId: TAG_ID, evidenceItemIds: manyIds, action: 'apply' },
      fakeRequest(),
    );
    expect(result.affected).toBe(1200);
    expect(assignmentCreateMany).toHaveBeenCalledTimes(3); // 500 + 500 + 200

    // Worker-contract index events: index:{id}:v{version}.
    const firstOutboxRows = (
      outboxCreateMany.mock.calls[0]?.[0] as {
        data: { topic: string; dedupKey: string; payload: Record<string, unknown> }[];
      }
    ).data;
    expect(firstOutboxRows[0]?.topic).toBe('search.index');
    expect(firstOutboxRows[0]?.dedupKey).toBe(`index:${manyIds[0]}:v3`);
    expect(firstOutboxRows[0]?.payload).toEqual({
      tenantId: TENANT_ID,
      evidenceItemId: manyIds[0],
      version: 3,
    });
  });

  it('409s when expectedTagVersion does not match the current definition', async () => {
    const { service } = makeService({
      tag: { findFirst: vi.fn(async () => tagRow({ version: 5 })) },
    });
    await expect(
      service.bulk(
        auth,
        { tagId: TAG_ID, evidenceItemIds: [ITEM_A], action: 'apply', expectedTagVersion: 4 },
        fakeRequest(),
      ),
    ).rejects.toThrow(ConflictException);
  });
});

describe('TagsService.update', () => {
  it('409s on optimistic version conflict', async () => {
    const { service } = makeService({
      tag: {
        findFirst: vi.fn(async () => tagRow({ version: 2 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    await expect(
      service.update(auth, TAG_ID, { name: 'Warm', version: 1 }, fakeRequest()),
    ).rejects.toThrow(ConflictException);
  });
});

describe('TagsService.remove', () => {
  it('blocks deletion while assignments exist unless forced', async () => {
    const tagDelete = vi.fn(async () => ({}));
    const { service, audit } = makeService({
      tag: { findFirst: vi.fn(async () => tagRow()), delete: tagDelete },
      tagAssignment: { count: vi.fn(async () => 7) },
    });
    await expect(service.remove(auth, TAG_ID, false, fakeRequest())).rejects.toThrow(
      ConflictException,
    );
    expect(tagDelete).not.toHaveBeenCalled();

    const result = await service.remove(auth, TAG_ID, true, fakeRequest());
    expect(result.assignmentsRemoved).toBe(7);
    expect(tagDelete).toHaveBeenCalledTimes(1);
    expect(audit.appendTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'tag.deleted',
        summary: expect.objectContaining({ assignmentsRemoved: 7, forced: true }),
      }),
    );
  });
});
