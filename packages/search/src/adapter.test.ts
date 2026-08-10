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

    expect(result).toEqual({ created: true, indexName: 'test-evidence-v1' });
    expect(client.indices.create).toHaveBeenCalledTimes(1);
    const call = client.indices.create.mock.calls[0]?.[0] as {
      index: string;
      body: Record<string, unknown>;
    };
    expect(call.index).toBe('test-evidence-v1');
    expect(call.body['aliases']).toEqual({ 'test-evidence': {} });
    expect(call.body['mappings']).toBeDefined();
    expect(call.body['settings']).toBeDefined();
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
      body: { actions: [{ add: { index: 'test-evidence-v1', alias: 'test-evidence' } }] },
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
    expect(result.errors).toEqual([
      { id: 'b', error: 'mapper_parsing_exception: bad field' },
    ]);
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
        items: [{ index: { _id: 'a', status: 429, error: { type: 'es_rejected', reason: 'busy' } } }],
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

    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'test-evidence' }),
    );
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

describe('reindexToNewVersion', () => {
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

    expect(result).toEqual({ indexName: 'test-evidence-v2', count: 3 });
    expect(client.indices.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'test-evidence-v2' }),
    );

    const firstBulk = client.bulk.mock.calls[0]?.[0]?.body as unknown[];
    expect(firstBulk[0]).toEqual({ index: { _index: 'test-evidence-v2', _id: 'a' } });

    expect(client.indices.updateAliases).toHaveBeenCalledTimes(1);
    expect(client.indices.updateAliases).toHaveBeenCalledWith({
      body: {
        actions: [
          { remove: { index: 'test-evidence-v1', alias: 'test-evidence' } },
          { add: { index: 'test-evidence-v2', alias: 'test-evidence' } },
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
