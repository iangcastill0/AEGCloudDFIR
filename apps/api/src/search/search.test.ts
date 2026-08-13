import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantRole } from '@aeg-clouddfir/database';
import type { SearchAdapter, SearchRequestBody } from '@aeg-clouddfir/search';
import { SearchService } from './search.service.js';
import {
  CASE_ID,
  TENANT_ID,
  fakeAudit,
  fakePrisma,
  fakeRequest,
  makeAuth,
} from '../testing/mocks.js';

interface CapturingAdapter extends SearchAdapter {
  lastBody?: SearchRequestBody;
}

function makeAdapter(total = 2): CapturingAdapter {
  const adapter: CapturingAdapter = {
    ensureIndex: vi.fn(),
    indexBulk: vi.fn(),
    deleteByTenant: vi.fn(),
    reindexToNewVersion: vi.fn(),
    health: vi.fn(),
    search: vi.fn(async (body: SearchRequestBody) => {
      adapter.lastBody = body;
      return { total, items: [], searchAfter: undefined, facets: {} };
    }),
  } as unknown as CapturingAdapter;
  return adapter;
}

function authFilters(body: SearchRequestBody | undefined): Record<string, unknown>[] {
  const query = body?.query as { bool?: { filter?: Record<string, unknown>[] } } | undefined;
  return query?.bool?.filter ?? [];
}

function makeService(models: Record<string, unknown>, adapter: CapturingAdapter) {
  const audit = fakeAudit();
  const service = new SearchService(fakePrisma(models), adapter, audit.service);
  return { service, audit };
}

describe('SearchService.execute', () => {
  it('maps a query syntax error to 400 with the character position', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({}, adapter);
    let caught: BadRequestException | undefined;
    try {
      await service.execute(
        makeAuth([TenantRole.case_manager]),
        { query: 'subject:(unclosed' },
        fakeRequest(),
      );
    } catch (err) {
      caught = err as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const response = caught?.getResponse() as { position?: number };
    expect(typeof response.position).toBe('number');
  });

  it('injects the read_only caller case memberships as a caseIds ACL (never null)', async () => {
    const adapter = makeAdapter();
    const { service } = makeService(
      {
        caseMember: {
          findMany: vi.fn(async () => [{ caseId: CASE_ID }, { caseId: TENANT_ID }]),
        },
      },
      adapter,
    );
    await service.execute(makeAuth([TenantRole.read_only]), { query: 'hello' }, fakeRequest());
    const filters = authFilters(adapter.lastBody);
    const caseFilter = filters.find((f) => 'terms' in f) as
      { terms: { caseIds: string[] } } | undefined;
    expect(caseFilter).toBeDefined();
    expect(caseFilter?.terms.caseIds).toEqual([CASE_ID, TENANT_ID]);
  });

  it('read_only with NO memberships still gets an (empty) case filter', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({ caseMember: { findMany: vi.fn(async () => []) } }, adapter);
    await service.execute(makeAuth([TenantRole.read_only]), { query: 'hello' }, fakeRequest());
    const caseFilter = authFilters(adapter.lastBody).find((f) => 'terms' in f) as
      { terms: { caseIds: string[] } } | undefined;
    expect(caseFilter?.terms.caseIds).toEqual([]);
  });

  it('read_only cannot search a case they are not assigned to (404, no leakage)', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({ caseMember: { findMany: vi.fn(async () => []) } }, adapter);
    await expect(
      service.execute(
        makeAuth([TenantRole.read_only]),
        { query: 'hello', caseId: CASE_ID },
        fakeRequest(),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('filters privileged material for a reviewer but not for a case_manager', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({}, adapter);

    await service.execute(makeAuth([TenantRole.reviewer]), { query: 'hello' }, fakeRequest());
    let filters = authFilters(adapter.lastBody);
    expect(filters).toContainEqual({ term: { privileged: false } });

    await service.execute(makeAuth([TenantRole.case_manager]), { query: 'hello' }, fakeRequest());
    filters = authFilters(adapter.lastBody);
    expect(filters).not.toContainEqual({ term: { privileged: false } });
    // Tenant isolation is unconditional.
    expect(filters).toContainEqual({ term: { tenantId: TENANT_ID } });
  });

  it('audits query shape and total, never result bodies', async () => {
    const adapter = makeAdapter(42);
    const { service, audit } = makeService({}, adapter);
    const result = await service.execute(
      makeAuth([TenantRole.case_manager]),
      { query: 'subject:report' },
      fakeRequest(),
    );
    expect(result.total).toBe(42);
    expect(typeof result.tookMs).toBe('number');
    expect(audit.append).toHaveBeenCalledTimes(1);
    const call = audit.append.mock.calls[0]?.[0] as {
      action: string;
      summary: Record<string, unknown>;
    };
    expect(call.action).toBe('search.executed');
    expect(call.summary.total).toBe(42);
    expect(call.summary.queryLength).toBe('subject:report'.length);
    expect(call.summary.items).toBeUndefined();
  });

  it('treats an empty request as tenant-scoped browse-all, newest first', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({}, adapter);
    const result = await service.execute(makeAuth([TenantRole.case_manager]), {}, fakeRequest());
    expect(result.total).toBe(2);
    // Tenant isolation is unconditional even for match-all browsing.
    const filters = authFilters(adapter.lastBody);
    expect(filters).toContainEqual({ term: { tenantId: TENANT_ID } });
    // Browse-all defaults to newest first (score is meaningless here).
    expect(JSON.stringify(adapter.lastBody)).toContain('dates.primary');
  });
});

describe('SearchService.explain', () => {
  it('returns a redacted structure: fields, clause count, highlight terms — no engine DSL', async () => {
    const adapter = makeAdapter();
    const { service } = makeService({}, adapter);
    const result = await service.explain(makeAuth([TenantRole.case_manager]), {
      query: 'subject:report AND from:alice@example.com',
    });
    expect(result.clauseCount).toBe(2);
    expect(result.fields).toContain('subject');
    expect(result.fields).toContain('from');
    expect(result.highlightTerms).toContain('report');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('bool');
    expect(serialized).not.toContain('tenantId');
  });
});
