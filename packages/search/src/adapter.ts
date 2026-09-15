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

/** Outcome of a server-side bulk field update (see addCaseToCollection). */
export interface UpdateByQueryResult {
  /** Documents the script actually changed. */
  updated: number;
  /** Documents matched but already correct — the script made them a no-op. */
  unchanged: number;
  /** Version conflicts skipped because another writer got there first. */
  conflicts: number;
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
  /**
   * Add one case id to every document of one collection, engine-side.
   *
   * The alternative is re-indexing each item, and that rebuilds the whole
   * document: ~12 SQL queries plus a download of its extracted text from object
   * storage, to change one field. On a 434,910-item collection that measured
   * out at 10-25 hours. This is one request.
   */
  addCaseToCollection(
    tenantId: string,
    collectionId: string,
    caseId: string,
  ): Promise<UpdateByQueryResult>;
  deleteByTenant(tenantId: string): Promise<void>;
  search(req: SearchRequestBody): Promise<SearchResponse>;
  reindexToNewVersion(
    loader: AsyncIterable<EvidenceSearchDoc[]>,
  ): Promise<{ indexName: string; count: number }>;
  health(): Promise<boolean>;
  checkReachable(): Promise<void>;
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
  aggregations?: Record<string, { buckets: { key: string | number; doc_count: number }[] }>;
}

export interface MinimalOpenSearchClient {
  indices: {
    existsAlias(params: { name: string; index?: string }): Promise<OsApiResponse<boolean>>;
    exists(params: { index: string }): Promise<OsApiResponse<boolean>>;
    create(params: {
      index: string;
      body: Record<string, unknown>;
    }): Promise<OsApiResponse<unknown>>;
    getAlias(params: {
      name: string;
      index?: string;
    }): Promise<OsApiResponse<Record<string, unknown>>>;
    updateAliases(params: {
      body: { actions: Record<string, unknown>[] };
    }): Promise<OsApiResponse<unknown>>;
  };
  bulk(params: { body: unknown[]; refresh?: boolean }): Promise<OsApiResponse<BulkResponseBody>>;
  search(params: {
    index: string;
    body: Record<string, unknown>;
  }): Promise<OsApiResponse<RawSearchBody>>;
  deleteByQuery(params: {
    index: string;
    body: Record<string, unknown>;
    refresh?: boolean;
  }): Promise<OsApiResponse<unknown>>;
  updateByQuery(params: {
    index: string;
    body: Record<string, unknown>;
    refresh?: boolean;
    conflicts?: string;
  }): Promise<OsApiResponse<UpdateByQueryBody>>;
  cluster: {
    health(): Promise<OsApiResponse<{ status: string }>>;
  };
}

export interface UpdateByQueryBody {
  total?: number;
  updated?: number;
  noops?: number;
  version_conflicts?: number;
  failures?: unknown[];
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

  /**
   * Index pattern the alias lookups are scoped to.
   *
   * `GET|HEAD /_alias/<name>` without an index is evaluated cluster-wide, so a
   * user restricted to its own indices gets 403 — which is what happened the
   * moment OpenSearch authentication was switched on: the worker logged "could
   * not ensure the search index" on every boot. Scoping the request to this
   * prefix asks the same question about the indices the app is allowed to see,
   * so the app needs no cluster-wide alias visibility.
   */
  private get indexScope(): string {
    return `${this.indexPrefix}-*`;
  }

  async ensureIndex(): Promise<{ created: boolean; indexName: string }> {
    const indexName = buildIndexName(this.indexPrefix, MAPPING_VERSION);
    const aliasExists = await this.client.indices.existsAlias({
      name: this.alias,
      index: this.indexScope,
    });
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

  /**
   * Stamp one case id onto every document of one collection, in one request.
   *
   * Why this exists: adding a collection to a case used to queue one re-index
   * job per item, and a re-index rebuilds the entire document — a Prisma read
   * with eleven nested includes, plus a download of the item's extracted text
   * from object storage, then a bulk call carrying a single document. All of
   * that to append one string to one field. Measured on a 434,910-item
   * collection that is 10-25 hours of queue. `_update_by_query` does it inside
   * the engine, touching no other service.
   *
   * This is a shortcut, not a second source of truth. `case_items` in Postgres
   * remains authoritative and the indexer rebuilds `caseIds` from it, so an
   * item re-indexed later for any other reason lands on the same answer. The
   * only thing this changes is how long the index takes to agree.
   *
   * `tenantId` is filtered on as well as `collectionId`, always. A collection
   * id is unique in practice, but the index holds every tenant's documents in
   * one place and the tenant term is the only isolation it has — so it is not
   * left to chance.
   */
  async addCaseToCollection(
    tenantId: string,
    collectionId: string,
    caseId: string,
  ): Promise<UpdateByQueryResult> {
    const response = await this.client.updateByQuery({
      index: this.alias,
      // 'proceed' rather than aborting: a document being re-indexed at the same
      // moment is a normal race, not a failure. The loser keeps the case id
      // anyway, because that re-index reads case_items from the database.
      conflicts: 'proceed',
      // The caller's next action is a search that must find these documents.
      refresh: true,
      body: {
        query: {
          bool: {
            filter: [{ term: { tenantId } }, { term: { collectionId } }],
          },
        },
        script: {
          lang: 'painless',
          // ctx.op = 'noop' matters: without it, re-running this rewrites every
          // document that already carries the id, which on a large collection
          // is a long and completely pointless write.
          source:
            'if (ctx._source.caseIds == null) { ctx._source.caseIds = [params.caseId]; } ' +
            'else if (!ctx._source.caseIds.contains(params.caseId)) { ctx._source.caseIds.add(params.caseId); } ' +
            "else { ctx.op = 'noop'; }",
          params: { caseId },
        },
      },
    });

    const body = response.body;
    const failures = body.failures ?? [];
    if (failures.length > 0) {
      throw new Error(
        `adding case ${caseId} to collection ${collectionId} failed for ` +
          `${String(failures.length)} document(s): ${JSON.stringify(failures[0])}`,
      );
    }
    return {
      updated: body.updated ?? 0,
      unchanged: body.noops ?? 0,
      conflicts: body.version_conflicts ?? 0,
    };
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
    const aliasResponse = await this.client.indices.getAlias({
      name: this.alias,
      index: this.indexScope,
    });
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

  /**
   * Readiness probe for the API: throws the underlying error instead of
   * flattening it to a boolean.
   *
   * `health()` above returns true/false, which cannot tell "OpenSearch is down"
   * from "the password is wrong" — and the caller needs that difference to know
   * whether to look at the cluster or at .env.
   *
   * Deliberately an alias lookup scoped to this app's own indices, not
   * `_cluster/health`: the app's user is granted cluster:monitor/health, so a
   * cluster probe answers 200 even when the app has no permission to read its
   * own data. This asks the question that matters — can I authenticate AND see
   * my index? — which is precisely the failure that followed switching
   * authentication on. A missing alias is not an error here; that is the
   * worker's job to create and log.
   */
  async checkReachable(): Promise<void> {
    await this.client.indices.existsAlias({ name: this.alias, index: this.indexScope });
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
