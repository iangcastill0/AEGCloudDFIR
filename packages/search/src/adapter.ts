/**
 * SearchAdapter: the replaceable engine boundary. The rest of the platform
 * only depends on this interface; OpenSearchAdapter is the default
 * implementation.
 */

import { Client } from '@opensearch-project/opensearch';
import type { SearchRequestBody } from './compile.js';
import type { EvidenceSearchDoc } from './document.js';
import { buildAliasName, buildIndexName, EVIDENCE_MAPPING, MAPPING_VERSION } from './mapping.js';

export interface BulkIndexResult {
  indexed: number;
  errors: { id: string; error: string }[];
}

export interface SearchHit {
  id: string;
  score: number | null;
  source: EvidenceSearchDoc;
  highlights?: Record<string, string[]>;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface SearchResponse {
  total: number;
  items: SearchHit[];
  /** Cursor for the next page (pass as searchAfter), if any results. */
  searchAfter?: (string | number)[];
  facets?: Record<string, FacetBucket[]>;
}

export interface SearchAdapter {
  ensureIndex(): Promise<{ created: boolean; indexName: string }>;
  indexBulk(docs: EvidenceSearchDoc[]): Promise<BulkIndexResult>;
  deleteByTenant(tenantId: string): Promise<void>;
  search(req: SearchRequestBody): Promise<SearchResponse>;
  reindexToNewVersion(
    loader: AsyncIterable<EvidenceSearchDoc[]>,
  ): Promise<{ indexName: string; count: number }>;
  health(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Minimal structural client (allows injecting a mock in tests)
// ---------------------------------------------------------------------------

export interface OsApiResponse<T> {
  body: T;
}

export interface BulkItemResult {
  index?: {
    _id?: string;
    status: number;
    error?: { type?: string; reason?: string };
  };
}

export interface BulkResponseBody {
  errors: boolean;
  items: BulkItemResult[];
}

export interface RawSearchHit {
  _id: string;
  _score: number | null;
  _source: EvidenceSearchDoc;
  highlight?: Record<string, string[]>;
  sort?: (string | number)[];
}

export interface RawSearchBody {
  hits: {
    total: { value: number } | number;
    hits: RawSearchHit[];
  };
  aggregations?: Record<
    string,
    { buckets: { key: string | number; doc_count: number }[] }
  >;
}

export interface MinimalOpenSearchClient {
  indices: {
    existsAlias(params: { name: string }): Promise<OsApiResponse<boolean>>;
    exists(params: { index: string }): Promise<OsApiResponse<boolean>>;
    create(params: {
      index: string;
      body: Record<string, unknown>;
    }): Promise<OsApiResponse<unknown>>;
    getAlias(params: { name: string }): Promise<OsApiResponse<Record<string, unknown>>>;
    updateAliases(params: {
      body: { actions: Record<string, unknown>[] };
    }): Promise<OsApiResponse<unknown>>;
  };
  bulk(params: {
    body: unknown[];
    refresh?: boolean;
  }): Promise<OsApiResponse<BulkResponseBody>>;
  search(params: {
    index: string;
    body: Record<string, unknown>;
  }): Promise<OsApiResponse<RawSearchBody>>;
  deleteByQuery(params: {
    index: string;
    body: Record<string, unknown>;
    refresh?: boolean;
  }): Promise<OsApiResponse<unknown>>;
  cluster: {
    health(): Promise<OsApiResponse<{ status: string }>>;
  };
}

export interface OpenSearchAdapterOptions {
  node: string;
  username?: string;
  password?: string;
  indexPrefix: string;
  /** Injectable client for tests; a real Client is created when omitted. */
  client?: MinimalOpenSearchClient;
  /** Max retries for per-item 429 bulk failures. */
  maxBulkRetries?: number;
  /** Base backoff delay in ms (doubles per attempt). */
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeBulkError(item: BulkItemResult['index']): string {
  if (!item) return 'missing bulk item result';
  if (item.error) {
    return `${item.error.type ?? 'error'}: ${item.error.reason ?? 'unknown reason'}`;
  }
  return `status ${item.status}`;
}

export class OpenSearchAdapter implements SearchAdapter {
  private readonly client: MinimalOpenSearchClient;
  private readonly indexPrefix: string;
  private readonly maxBulkRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: OpenSearchAdapterOptions) {
    this.indexPrefix = options.indexPrefix;
    this.maxBulkRetries = options.maxBulkRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.client =
      options.client ??
      (new Client({
        node: options.node,
        ...(options.username !== undefined && options.password !== undefined
          ? { auth: { username: options.username, password: options.password } }
          : {}),
      }) as unknown as MinimalOpenSearchClient);
  }

  private get alias(): string {
    return buildAliasName(this.indexPrefix);
  }

  async ensureIndex(): Promise<{ created: boolean; indexName: string }> {
    const indexName = buildIndexName(this.indexPrefix, MAPPING_VERSION);
    const aliasExists = await this.client.indices.existsAlias({ name: this.alias });
    if (aliasExists.body) {
      return { created: false, indexName };
    }
    const indexExists = await this.client.indices.exists({ index: indexName });
    if (!indexExists.body) {
      await this.client.indices.create({
        index: indexName,
        body: {
          ...(EVIDENCE_MAPPING as unknown as Record<string, unknown>),
          aliases: { [this.alias]: {} },
        },
      });
      return { created: true, indexName };
    }
    await this.client.indices.updateAliases({
      body: { actions: [{ add: { index: indexName, alias: this.alias } }] },
    });
    return { created: false, indexName };
  }

  async indexBulk(docs: EvidenceSearchDoc[]): Promise<BulkIndexResult> {
    return this.bulkInto(this.alias, docs);
  }

  private async bulkInto(indexName: string, docs: EvidenceSearchDoc[]): Promise<BulkIndexResult> {
    const errors: { id: string; error: string }[] = [];
    let indexed = 0;
    let pending = docs;

    for (let attempt = 0; attempt <= this.maxBulkRetries && pending.length > 0; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }

      const body = pending.flatMap((doc) => [
        { index: { _index: indexName, _id: doc.evidenceItemId } },
        doc,
      ]);
      const response = await this.client.bulk({ body });
      const items = response.body.items ?? [];
      const retry: EvidenceSearchDoc[] = [];

      for (let i = 0; i < pending.length; i += 1) {
        const doc = pending[i];
        if (!doc) continue;
        const result = items[i]?.index;
        if (!result) {
          errors.push({ id: doc.evidenceItemId, error: 'missing bulk item result' });
          continue;
        }
        if (!result.error && result.status < 300) {
          indexed += 1;
          continue;
        }
        if (result.status === 429 && attempt < this.maxBulkRetries) {
          retry.push(doc);
          continue;
        }
        errors.push({ id: doc.evidenceItemId, error: describeBulkError(result) });
      }

      pending = retry;
    }

    return { indexed, errors };
  }

  async deleteByTenant(tenantId: string): Promise<void> {
    await this.client.deleteByQuery({
      index: this.alias,
      body: { query: { term: { tenantId } } },
      refresh: true,
    });
  }

  async search(req: SearchRequestBody): Promise<SearchResponse> {
    const response = await this.client.search({
      index: this.alias,
      body: req as unknown as Record<string, unknown>,
    });
    const { hits, aggregations } = response.body;

    const items: SearchHit[] = hits.hits.map((hit) => {
      const item: SearchHit = {
        id: hit._id,
        score: hit._score ?? null,
        source: hit._source,
      };
      if (hit.highlight) item.highlights = hit.highlight;
      return item;
    });

    const result: SearchResponse = {
      total: typeof hits.total === 'number' ? hits.total : hits.total.value,
      items,
    };

    const lastSort = hits.hits.at(-1)?.sort;
    if (lastSort) {
      result.searchAfter = lastSort;
    }

    if (aggregations) {
      const facets: Record<string, FacetBucket[]> = {};
      for (const [name, agg] of Object.entries(aggregations)) {
        facets[name] = agg.buckets.map((bucket) => ({
          value: String(bucket.key),
          count: bucket.doc_count,
        }));
      }
      result.facets = facets;
    }

    return result;
  }

  async reindexToNewVersion(
    loader: AsyncIterable<EvidenceSearchDoc[]>,
  ): Promise<{ indexName: string; count: number }> {
    const aliasResponse = await this.client.indices.getAlias({ name: this.alias });
    const currentIndices = Object.keys(aliasResponse.body);
    if (currentIndices.length === 0) {
      throw new Error(`Alias ${this.alias} does not point at any index; run ensureIndex first`);
    }

    const versions = currentIndices
      .map((name) => /-evidence-v(\d+)$/.exec(name))
      .map((match) => (match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0));
    const nextVersion = Math.max(...versions, MAPPING_VERSION) + 1;
    const newIndex = buildIndexName(this.indexPrefix, nextVersion);

    await this.client.indices.create({
      index: newIndex,
      body: EVIDENCE_MAPPING as unknown as Record<string, unknown>,
    });

    let count = 0;
    for await (const batch of loader) {
      if (batch.length === 0) continue;
      const result = await this.bulkInto(newIndex, batch);
      if (result.errors.length > 0) {
        throw new Error(
          `Reindex to ${newIndex} aborted: ${result.errors.length} document(s) failed ` +
            `(first: ${result.errors[0]?.id} — ${result.errors[0]?.error}); alias not swapped`,
        );
      }
      count += result.indexed;
    }

    // Atomic alias swap: remove all current indices, add the new one.
    await this.client.indices.updateAliases({
      body: {
        actions: [
          ...currentIndices.map((index) => ({ remove: { index, alias: this.alias } })),
          { add: { index: newIndex, alias: this.alias } },
        ],
      },
    });

    return { indexName: newIndex, count };
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.client.cluster.health();
      return response.body.status === 'green' || response.body.status === 'yellow';
    } catch (error) {
      console.error('OpenSearch health check failed:', error);
      return false;
    }
  }
}
