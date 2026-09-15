import { describe, expect, it, vi } from 'vitest';
import {
  OpenSearchAdapter,
  type BulkResponseBody,
  type MinimalOpenSearchClient,
  type RawSearchBody,
} from './adapter.js';
import type { EvidenceSearchDoc } from './document.js';

function doc(id: string): EvidenceSearchDoc {
  return {
    evidenceItemId: id,
    tenantId: 'tenant-1',
    kind: 'email',
    name: `${id}.eml`,
    dates: { primary: '2024-01-01T00:00:00Z' },
    privileged: false,
    confidential: false,
    hasBeenProduced: false,
    indexedAt: '2024-01-02T00:00:00Z',
    docVersion: 1,
  };
}

function bulkOk(ids: string[]): BulkResponseBody {
  return {
    errors: false,
    items: ids.map((id) => ({ index: { _id: id, status: 201 } })),
  };
}

interface MockClient extends MinimalOpenSearchClient {
  indices: MinimalOpenSearchClient['indices'] & {
    existsAlias: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getAlias: ReturnType<typeof vi.fn>;
    updateAliases: ReturnType<typeof vi.fn>;
  };
  bulk: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  deleteByQuery: ReturnType<typeof vi.fn>;
  updateByQuery: ReturnType<typeof vi.fn>;
  cluster: { health: ReturnType<typeof vi.fn> };
}

function mockClient(): MockClient {
  return {
    indices: {
      existsAlias: vi.fn().mockResolvedValue({ body: false }),
      exists: vi.fn().mockResolvedValue({ body: false }),
      create: vi.fn().mockResolvedValue({ body: {} }),
      getAlias: vi.fn().mockResolvedValue({ body: {} }),
      updateAliases: vi.fn().mockResolvedValue({ body: {} }),
    },
    bulk: vi.fn().mockResolvedValue({ body: bulkOk([]) }),
    search: vi.fn().mockResolvedValue({
      body: { hits: { total: { value: 0 }, hits: [] } } satisfies RawSearchBody,
    }),
    deleteByQuery: vi.fn().mockResolvedValue({ body: {} }),
    updateByQuery: vi
      .fn()
      .mockResolvedValue({ body: { total: 0, updated: 0, noops: 0, version_conflicts: 0 } }),
    cluster: { health: vi.fn().mockResolvedValue({ body: { status: 'green' } }) },
  };
}

function adapter(client: MockClient, overrides: { maxBulkRetries?: number } = {}) {
  return new OpenSearchAdapter({
    node: 'http://localhost:9200',
    indexPrefix: 'test',
    client,
    retryDelayMs: 0,
    ...overrides,
  });
}

describe('ensureIndex', () => {
  it('creates the versioned index with the alias when nothing exists', async () => {
    const client = mockClient();
    const result = await adapter(client).ensureIndex();

    expect(result).toEqual({ created: true, indexName: 'test-evidence-v2' });
    expect(client.indices.create).toHaveBeenCalledTimes(1);
    const call = client.indices.create.mock.calls[0]?.[0] as {
      index: string;
      body: Record<string, unknown>;
    };
    expect(call.index).toBe('test-evidence-v2');
    expect(call.body['aliases']).toEqual({ 'test-evidence': {} });
    expect(call.body['mappings']).toBeDefined();
    expect(call.body['settings']).toBeDefined();
  });

  it('scopes the alias lookup to its own indices, not the whole cluster', async () => {
    // `HEAD /_alias/<name>` with no index is authorized cluster-wide, so a user
    // restricted to its own indices gets 403. That is exactly what happened the
    // day OpenSearch authentication was enabled: every worker boot logged
    // "could not ensure the search index". Asking about `<prefix>-*` is the same
    // question, scoped to what the app is allowed to see.
    const client = mockClient();
    client.indices.existsAlias.mockResolvedValue({ body: true });

    await adapter(client).ensureIndex();

    expect(client.indices.existsAlias).toHaveBeenCalledWith({
      name: 'test-evidence',
      index: 'test-*',
    });
  });

  it('does nothing when the alias already exists', async () => {
    const client = mockClient();
    client.indices.existsAlias.mockResolvedValue({ body: true });

    const result = await adapter(client).ensureIndex();
    expect(result.created).toBe(false);
    expect(client.indices.create).not.toHaveBeenCalled();
  });

  it('re-links the alias when the index exists but the alias is missing', async () => {
    const client = mockClient();
    client.indices.exists.mockResolvedValue({ body: true });

    const result = await adapter(client).ensureIndex();
    expect(result.created).toBe(false);
    expect(client.indices.create).not.toHaveBeenCalled();
    expect(client.indices.updateAliases).toHaveBeenCalledWith({
      body: { actions: [{ add: { index: 'test-evidence-v2', alias: 'test-evidence' } }] },
    });
  });
});

describe('indexBulk', () => {
  it('indexes docs via the alias with the evidence id as _id', async () => {
    const client = mockClient();
    client.bulk.mockResolvedValue({ body: bulkOk(['a', 'b']) });

    const result = await adapter(client).indexBulk([doc('a'), doc('b')]);
    expect(result).toEqual({ indexed: 2, errors: [] });

    const body = client.bulk.mock.calls[0]?.[0]?.body as unknown[];
    expect(body).toHaveLength(4);
    expect(body[0]).toEqual({ index: { _index: 'test-evidence', _id: 'a' } });
    expect(body[2]).toEqual({ index: { _index: 'test-evidence', _id: 'b' } });
  });

  it('maps per-item failures to errors without retrying non-429s', async () => {
    const client = mockClient();
    client.bulk.mockResolvedValue({
      body: {
        errors: true,
        items: [
          { index: { _id: 'a', status: 201 } },
          {
            index: {
              _id: 'b',
              status: 400,
              error: { type: 'mapper_parsing_exception', reason: 'bad field' },
            },
          },
        ],
      } satisfies BulkResponseBody,
    });

    const result = await adapter(client).indexBulk([doc('a'), doc('b')]);
    expect(client.bulk).toHaveBeenCalledTimes(1);
    expect(result.indexed).toBe(1);
    expect(result.errors).toEqual([{ id: 'b', error: 'mapper_parsing_exception: bad field' }]);
  });

  it('retries only the 429-throttled docs and succeeds', async () => {
    const client = mockClient();
    client.bulk
      .mockResolvedValueOnce({
        body: {
          errors: true,
          items: [
            { index: { _id: 'a', status: 201 } },
            { index: { _id: 'b', status: 429, error: { type: 'es_rejected', reason: 'busy' } } },
          ],
        } satisfies BulkResponseBody,
      })
      .mockResolvedValueOnce({ body: bulkOk(['b']) });

    const result = await adapter(client).indexBulk([doc('a'), doc('b')]);
    expect(result).toEqual({ indexed: 2, errors: [] });
    expect(client.bulk).toHaveBeenCalledTimes(2);

    const retryBody = client.bulk.mock.calls[1]?.[0]?.body as unknown[];
    expect(retryBody).toHaveLength(2);
    expect(retryBody[0]).toEqual({ index: { _index: 'test-evidence', _id: 'b' } });
  });

  it('gives up on persistent 429s after the retry budget and reports the error', async () => {
    const client = mockClient();
    client.bulk.mockResolvedValue({
      body: {
        errors: true,
        items: [
          { index: { _id: 'a', status: 429, error: { type: 'es_rejected', reason: 'busy' } } },
        ],
      } satisfies BulkResponseBody,
    });

    const result = await adapter(client, { maxBulkRetries: 2 }).indexBulk([doc('a')]);
    // initial attempt + 2 retries:
    expect(client.bulk).toHaveBeenCalledTimes(3);
    expect(result.indexed).toBe(0);
    expect(result.errors).toEqual([{ id: 'a', error: 'es_rejected: busy' }]);
  });

  it('returns immediately for an empty batch', async () => {
    const client = mockClient();
    const result = await adapter(client).indexBulk([]);
    expect(result).toEqual({ indexed: 0, errors: [] });
    expect(client.bulk).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  it('executes against the alias and maps hits, cursor and facets', async () => {
    const client = mockClient();
    client.search.mockResolvedValue({
      body: {
        hits: {
          total: { value: 42 },
          hits: [
            {
              _id: 'a',
              _score: 1.5,
              _source: doc('a'),
              highlight: { 'text.body': ['<mark>foo</mark>'] },
              sort: [100, 'a'],
            },
            { _id: 'b', _score: 1.1, _source: doc('b'), sort: [90, 'b'] },
          ],
        },
        aggregations: {
          custodianEmail: {
            buckets: [
              { key: 'alice@x.com', doc_count: 30 },
              { key: 'bob@x.com', doc_count: 12 },
            ],
          },
        },
      } satisfies RawSearchBody,
    });

    const response = await adapter(client).search({
      query: { bool: { filter: [{ term: { tenantId: 'tenant-1' } }], must: [{ match_all: {} }] } },
      size: 50,
      sort: [],
      track_total_hits: true,
    });

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ index: 'test-evidence' }));
    expect(response.total).toBe(42);
    expect(response.items).toHaveLength(2);
    expect(response.items[0]).toMatchObject({
      id: 'a',
      score: 1.5,
      highlights: { 'text.body': ['<mark>foo</mark>'] },
    });
    expect(response.items[1]?.highlights).toBeUndefined();
    expect(response.searchAfter).toEqual([90, 'b']);
    expect(response.facets).toEqual({
      custodianEmail: [
        { value: 'alice@x.com', count: 30 },
        { value: 'bob@x.com', count: 12 },
      ],
    });
  });

  it('omits the cursor when there are no hits', async () => {
    const client = mockClient();
    const response = await adapter(client).search({
      query: {},
      size: 50,
      sort: [],
      track_total_hits: true,
    });
    expect(response.total).toBe(0);
    expect(response.searchAfter).toBeUndefined();
    expect(response.facets).toBeUndefined();
  });
});

describe('deleteByTenant', () => {
  it('issues a term-filtered delete-by-query against the alias', async () => {
    const client = mockClient();
    await adapter(client).deleteByTenant('tenant-1');
    expect(client.deleteByQuery).toHaveBeenCalledWith({
      index: 'test-evidence',
      body: { query: { term: { tenantId: 'tenant-1' } } },
      refresh: true,
    });
  });
});

describe('checkReachable', () => {
  it('resolves when the alias lookup succeeds', async () => {
    const client = mockClient();
    client.indices.existsAlias.mockResolvedValue({ body: true });
    await expect(adapter(client).checkReachable()).resolves.toBeUndefined();
  });

  it('resolves when the alias does not exist yet', async () => {
    // A fresh deployment has no index until the worker creates one. That is not
    // a readiness failure, or the very first deploy could never pass its health
    // gate.
    const client = mockClient();
    client.indices.existsAlias.mockResolvedValue({ body: false });
    await expect(adapter(client).checkReachable()).resolves.toBeUndefined();
  });

  it('propagates the error rather than flattening it to false', async () => {
    // readyz names the failure so the operator knows whether to look at the
    // cluster or at the password. health() returns a boolean and cannot.
    const client = mockClient();
    const err = new Error('Response Error');
    err.name = 'ResponseError';
    client.indices.existsAlias.mockRejectedValue(err);
    await expect(adapter(client).checkReachable()).rejects.toThrow(/Response Error/);
  });

  it('asks about its own indices, so a restricted user is not refused', async () => {
    const client = mockClient();
    client.indices.existsAlias.mockResolvedValue({ body: true });
    await adapter(client).checkReachable();
    expect(client.indices.existsAlias).toHaveBeenCalledWith({
      name: 'test-evidence',
      index: 'test-*',
    });
  });
});

describe('reindexToNewVersion', () => {
  it('scopes its alias lookup too, so reindexing works for a restricted user', async () => {
    // Same 403 as ensureIndex, but it would only surface during a reindex —
    // i.e. while recovering from a mapping change, the worst time to find it.
    const client = mockClient();
    client.indices.getAlias.mockResolvedValue({
      body: { 'test-evidence-v2': { aliases: { 'test-evidence': {} } } },
    });
    client.bulk.mockResolvedValueOnce({ body: bulkOk(['a']) });

    await adapter(client).reindexToNewVersion(batches([doc('a')]));

    expect(client.indices.getAlias).toHaveBeenCalledWith({
      name: 'test-evidence',
      index: 'test-*',
    });
  });

  async function* batches(...groups: EvidenceSearchDoc[][]) {
    for (const group of groups) yield group;
  }

  it('creates v(N+1), streams batches into it, then swaps the alias atomically', async () => {
    const client = mockClient();
    client.indices.getAlias.mockResolvedValue({
      body: { 'test-evidence-v1': { aliases: { 'test-evidence': {} } } },
    });
    client.bulk
      .mockResolvedValueOnce({ body: bulkOk(['a', 'b']) })
      .mockResolvedValueOnce({ body: bulkOk(['c']) });

    const result = await adapter(client).reindexToNewVersion(
      batches([doc('a'), doc('b')], [doc('c')]),
    );

    expect(result).toEqual({ indexName: 'test-evidence-v3', count: 3 });
    expect(client.indices.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'test-evidence-v3' }),
    );

    const firstBulk = client.bulk.mock.calls[0]?.[0]?.body as unknown[];
    expect(firstBulk[0]).toEqual({ index: { _index: 'test-evidence-v3', _id: 'a' } });

    expect(client.indices.updateAliases).toHaveBeenCalledTimes(1);
    expect(client.indices.updateAliases).toHaveBeenCalledWith({
      body: {
        actions: [
          { remove: { index: 'test-evidence-v1', alias: 'test-evidence' } },
          { add: { index: 'test-evidence-v3', alias: 'test-evidence' } },
        ],
      },
    });
  });

  it('parses the highest existing version to pick the next one', async () => {
    const client = mockClient();
    client.indices.getAlias.mockResolvedValue({
      body: { 'test-evidence-v7': {} },
    });
    client.bulk.mockResolvedValue({ body: bulkOk(['a']) });
    const result = await adapter(client).reindexToNewVersion(batches([doc('a')]));
    expect(result.indexName).toBe('test-evidence-v8');
  });

  it('aborts without swapping the alias when a batch fails', async () => {
    const client = mockClient();
    client.indices.getAlias.mockResolvedValue({ body: { 'test-evidence-v1': {} } });
    client.bulk.mockResolvedValue({
      body: {
        errors: true,
        items: [{ index: { _id: 'a', status: 400, error: { type: 'boom', reason: 'bad' } } }],
      } satisfies BulkResponseBody,
    });

    await expect(adapter(client).reindexToNewVersion(batches([doc('a')]))).rejects.toThrow(
      /alias not swapped/,
    );
    expect(client.indices.updateAliases).not.toHaveBeenCalled();
  });

  it('refuses to reindex when the alias points nowhere', async () => {
    const client = mockClient();
    client.indices.getAlias.mockResolvedValue({ body: {} });
    await expect(adapter(client).reindexToNewVersion(batches([doc('a')]))).rejects.toThrow(
      /ensureIndex/,
    );
  });
});

describe('health', () => {
  it('is healthy on green and yellow', async () => {
    const client = mockClient();
    expect(await adapter(client).health()).toBe(true);
    client.cluster.health.mockResolvedValue({ body: { status: 'yellow' } });
    expect(await adapter(client).health()).toBe(true);
  });

  it('is unhealthy on red', async () => {
    const client = mockClient();
    client.cluster.health.mockResolvedValue({ body: { status: 'red' } });
    expect(await adapter(client).health()).toBe(false);
  });

  it('is unhealthy when the cluster is unreachable', async () => {
    const client = mockClient();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.cluster.health.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await adapter(client).health()).toBe(false);
    consoleError.mockRestore();
  });
});

describe('addCaseToCollection', () => {
  /**
   * Why this exists at all: the alternative is one re-index job per item, and a
   * re-index rebuilds the whole document — a database read with eleven nested
   * includes plus a download of the item's extracted text from object storage.
   * On a real 434,910-item collection that measured 10-25 hours of queue, to
   * append one string to one field. This is a single request.
   */
  function callBody(client: MockClient): Record<string, unknown> {
    return client.updateByQuery.mock.calls[0]?.[0]?.body as Record<string, unknown>;
  }

  function filters(client: MockClient): Record<string, unknown>[] {
    const query = callBody(client).query as { bool?: { filter?: Record<string, unknown>[] } };
    return query.bool?.filter ?? [];
  }

  it('filters on the tenant as well as the collection', async () => {
    // The index holds every tenant's documents in one place, and the tenant
    // term is the only isolation it has. A collection id is unique in practice,
    // but "in practice" is not a boundary.
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');

    expect(filters(client)).toEqual([
      { term: { tenantId: 'tenant-1' } },
      { term: { collectionId: 'coll-1' } },
    ]);
  });

  it('writes to the alias, not a versioned index name', async () => {
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');
    expect(client.updateByQuery.mock.calls[0]?.[0]?.index).toBe('test-evidence');
  });

  it('passes the case id as a script parameter, never inlined', async () => {
    // Inlining it into the script source would be a painless injection point
    // and would defeat the script cache.
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');

    const script = callBody(client).script as { source: string; params: Record<string, string> };
    expect(script.params).toEqual({ caseId: 'case-1' });
    expect(script.source).not.toContain('case-1');
  });

  it('makes a document that already carries the id a no-op', async () => {
    // Without this, re-running rewrites every document that is already correct.
    // On a 434,910-item collection that is a long and completely pointless
    // write, and it is the normal case for a retry.
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');

    const script = callBody(client).script as { source: string };
    expect(script.source).toContain("ctx.op = 'noop'");
    expect(script.source).toContain('contains(params.caseId)');
  });

  it('creates the field when a document has no caseIds yet', async () => {
    // buildSearchDoc omits caseIds entirely when the list is empty, so most
    // documents reaching this script have no such field at all. Appending to a
    // null would throw for every one of them.
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');

    const script = callBody(client).script as { source: string };
    expect(script.source).toContain('ctx._source.caseIds == null');
  });

  it('refreshes, because the caller is about to search for these documents', async () => {
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');
    expect(client.updateByQuery.mock.calls[0]?.[0]?.refresh).toBe(true);
  });

  it('proceeds through version conflicts rather than aborting', async () => {
    // A document being re-indexed at the same moment is a normal race. The
    // loser keeps the case id anyway: that re-index reads case_items from the
    // database, which the API wrote before queueing this work.
    const client = mockClient();
    await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1');
    expect(client.updateByQuery.mock.calls[0]?.[0]?.conflicts).toBe('proceed');
  });

  it('reports what actually changed', async () => {
    const client = mockClient();
    client.updateByQuery.mockResolvedValue({
      body: { total: 100, updated: 90, noops: 8, version_conflicts: 2 },
    });

    expect(await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1')).toEqual({
      updated: 90,
      unchanged: 8,
      conflicts: 2,
    });
  });

  it('treats missing counters as zero rather than NaN', async () => {
    const client = mockClient();
    client.updateByQuery.mockResolvedValue({ body: {} });

    expect(await adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1')).toEqual({
      updated: 0,
      unchanged: 0,
      conflicts: 0,
    });
  });

  it('throws when the engine reports per-document failures', async () => {
    // A partial success reported as success would leave a case quietly missing
    // items, and nothing downstream would ever notice.
    const client = mockClient();
    client.updateByQuery.mockResolvedValue({
      body: { updated: 10, failures: [{ id: 'doc-1', cause: { reason: 'mapping conflict' } }] },
    });

    await expect(
      adapter(client).addCaseToCollection('tenant-1', 'coll-1', 'case-1'),
    ).rejects.toThrow(/mapping conflict/);
  });
});
