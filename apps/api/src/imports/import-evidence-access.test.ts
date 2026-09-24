import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import { EvidenceService } from '../evidence/evidence.service.js';
import {
  ITEM_A,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
  testConfig,
} from '../testing/mocks.js';

describe('import evidence access', () => {
  it('hides native bytes from another case manager before case attachment', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: ITEM_A,
        name: 'private.json',
        size: 10n,
        malwareStatus: 'clean',
        blob: {
          objectKey: `tenants/${TENANT_ID}/originals/sha256/aa/${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
        },
      })
      .mockResolvedValueOnce({
        forensicImport: {
          createdById: '99999999-9999-4999-8999-999999999999',
          cases: [],
        },
      });
    const prisma = fakePrisma({ evidenceItem: { findFirst }, caseItem: { count: vi.fn() } });
    const presignGet = vi.fn();
    const audit = fakeAudit();
    const service = new EvidenceService(
      prisma,
      testConfig(),
      { presignGet } as never,
      audit.service,
    );

    await expect(
      service.native(makeAuth([TenantRole.case_manager]), ITEM_A, false, fakeRequest()),
    ).rejects.toThrow(NotFoundException);
    expect(presignGet).not.toHaveBeenCalled();
  });
});
