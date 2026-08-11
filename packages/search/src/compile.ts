/**
 * Compiles a ValidatedAst into OpenSearch query DSL.
 *
 * SECURITY INVARIANT: every compiled query is wrapped by
 * `wrapWithAuthorization`, which injects an unconditional tenantId filter
 * plus optional case-ACL and privilege filters. `compile` has no code path
 * that returns an unwrapped query, and `buildSearchRequest` only builds
 * request bodies through `compile`.
 */

import { QueryValidationError } from './errors.js';
import { ALL_TEXT_FIELDS, ALL_TEXT_PATH, type ResolvedField } from './fields.js';
import type { ValidatedAst, ValidatedNode } from './validate.js';

export type QueryDsl = { [key: string]: unknown };

export interface AuthContext {
  tenantId: string;
  /**
   * Case ACL: null/undefined means "no case restriction" (tenant-wide
   * access); an array restricts to those cases — an EMPTY array matches
   * nothing by design.
   */
  caseIds?: string[] | null;
  includePrivileged: boolean;
}

/** Fields that have a `.keyword` multi-field for exact/wildcard matching. */
const KEYWORD_MULTIFIELDS: ReadonlySet<string> = new Set(['name', 'email.subject']);

function wildcardPath(esPath: string): string {
  return KEYWORD_MULTIFIELDS.has(esPath) ? `${esPath}.keyword` : esPath;
}

function isEmailAddress(value: string): boolean {
  return value.includes('@');
}

function addressPaths(field: ResolvedField, value: string): string {
  // `participants` resolves to the normalized addresses object.
  if (field.esPath === 'addresses') {
    return isEmailAddress(value) ? 'addresses.all' : 'addresses.domains';
  }
  return isEmailAddress(value) ? `${field.esPath}.address` : `${field.esPath}.domain`;
}

function headerQuery(field: ResolvedField, valueQuery: QueryDsl): QueryDsl {
  return {
    nested: {
      path: 'headers',
      query: {
        bool: {
          must: [{ term: { 'headers.name': field.headerName ?? '' } }, valueQuery],
        },
      },
    },
  };
}

function ocrQuery(matchType: 'match' | 'match_phrase', body: QueryDsl): QueryDsl {
  return {
    bool: {
      should: [
        { [matchType]: { 'text.ocr': body } },
        {
          nested: {
            path: 'ocrPages',
            query: { [matchType]: { 'ocrPages.text': body } },
          },
        },
      ],
      minimum_should_match: 1,
    },
  };
}

function batesQuery(value: string): QueryDsl {
  const normalized = value.toLowerCase();
  return {
    nested: {
      path: 'bates',
      query: {
        bool: {
          should: [
            { term: { 'bates.begBates': normalized } },
            { term: { 'bates.endBates': normalized } },
          ],
          minimum_should_match: 1,
        },
      },
    },
  };
}

function compileTerm(node: Extract<ValidatedNode, { kind: 'term' }>): QueryDsl {
  const { field, value, fuzzy } = node;

  switch (field.type) {
    case 'header': {
      const match: QueryDsl =
        fuzzy !== undefined
          ? { match: { 'headers.value': { query: String(value), fuzziness: fuzzy } } }
          : { match: { 'headers.value': { query: String(value) } } };
      return headerQuery(field, match);
    }
    case 'ocr': {
      const body: QueryDsl =
        fuzzy !== undefined ? { query: String(value), fuzziness: fuzzy } : { query: String(value) };
      return ocrQuery('match', body);
    }
    case 'address': {
      const path = addressPaths(field, String(value));
      return { term: { [path]: String(value).toLowerCase() } };
    }
    case 'boolean':
      return { term: { [field.esPath]: value === true } };
    case 'size':
      return { term: { [field.esPath]: value } };
    case 'keyword': {
      if (field.name === 'bates') {
        return batesQuery(String(value));
      }
      if (fuzzy !== undefined) {
        return { fuzzy: { [field.esPath]: { value: String(value), fuzziness: fuzzy } } };
      }
      return { term: { [field.esPath]: String(value).toLowerCase() } };
    }
    case 'text': {
      if (field.esPath === ALL_TEXT_PATH) {
        const multi: QueryDsl = {
          query: String(value),
          fields: [...ALL_TEXT_FIELDS],
        };
        if (fuzzy !== undefined) multi.fuzziness = fuzzy;
        return { multi_match: multi };
      }
      const body: QueryDsl = { query: String(value) };
      if (fuzzy !== undefined) body.fuzziness = fuzzy;
      return { match: { [field.esPath]: body } };
    }
    case 'date':
      // Validation rewrites date terms into ranges; this is unreachable but
      // kept total for type safety.
      return { term: { [field.esPath]: String(value) } };
  }
}

function compilePhrase(node: Extract<ValidatedNode, { kind: 'phrase' }>): QueryDsl {
  const { field, value, proximity } = node;
  const slop = proximity ?? 0;

  switch (field.type) {
    case 'header':
      return headerQuery(field, {
        match_phrase: { 'headers.value': { query: value, slop } },
      });
    case 'ocr':
      return ocrQuery('match_phrase', { query: value, slop });
    case 'address': {
      const path = addressPaths(field, value);
      return { term: { [path]: value.toLowerCase() } };
    }
    case 'keyword':
      if (field.name === 'bates') return batesQuery(value);
      return { term: { [field.esPath]: value.toLowerCase() } };
    case 'text': {
      if (field.esPath === ALL_TEXT_PATH) {
        return {
          multi_match: {
            query: value,
            type: 'phrase',
            slop,
            fields: [...ALL_TEXT_FIELDS],
          },
        };
      }
      return { match_phrase: { [field.esPath]: { query: value, slop } } };
    }
    default:
      // Validation forbids phrases on date/size/boolean fields.
      return { match_phrase: { [field.esPath]: { query: value, slop } } };
  }
}

function compileWildcard(node: Extract<ValidatedNode, { kind: 'wildcard' }>): QueryDsl {
  const { field, value } = node;

  const wildcard = (path: string): QueryDsl => ({
    wildcard: { [path]: { value: value.toLowerCase(), case_insensitive: true } },
  });

  switch (field.type) {
    case 'header':
      return headerQuery(field, wildcard('headers.value.keyword'));
    case 'ocr':
      return wildcard('text.ocr');
    case 'address': {
      const path = addressPaths(field, value);
      return wildcard(path);
    }
    case 'keyword':
      if (field.name === 'bates') {
        return {
          nested: {
            path: 'bates',
            query: {
              bool: {
                should: [wildcard('bates.begBates'), wildcard('bates.endBates')],
                minimum_should_match: 1,
              },
            },
          },
        };
      }
      return wildcard(field.esPath);
    case 'text': {
      if (field.esPath === ALL_TEXT_PATH) {
        return {
          bool: {
            should: ALL_TEXT_FIELDS.map((path) => wildcard(wildcardPath(path))),
            minimum_should_match: 1,
          },
        };
      }
      return wildcard(wildcardPath(field.esPath));
    }
    default:
      return wildcard(wildcardPath(field.esPath));
  }
}

function compileExists(node: Extract<ValidatedNode, { kind: 'exists' }>): QueryDsl {
  const { field } = node;
  if (field.type === 'header') {
    return {
      nested: {
        path: 'headers',
        query: { term: { 'headers.name': field.headerName ?? '' } },
      },
    };
  }
  if (field.type === 'address') {
    const path = field.esPath === 'addresses' ? 'addresses.all' : `${field.esPath}.address`;
    return { exists: { field: path } };
  }
  return { exists: { field: field.esPath } };
}

/**
 * Compile a single validated node to query DSL. Exported so tests can verify
 * that `compile(ast, auth)` is exactly `wrapWithAuthorization(compileNode(ast.root), auth)`
 * — i.e. that no compilation path skips the authorization wrapper.
 */
export function compileNode(node: ValidatedNode): QueryDsl {
  switch (node.kind) {
    case 'match_all':
      return { match_all: {} };
    case 'and':
      return { bool: { must: node.children.map(compileNode) } };
    case 'or':
      return {
        bool: {
          should: node.children.map(compileNode),
          minimum_should_match: 1,
        },
      };
    case 'not':
      return { bool: { must_not: [compileNode(node.child)] } };
    case 'term':
      return compileTerm(node);
    case 'phrase':
      return compilePhrase(node);
    case 'wildcard':
      return compileWildcard(node);
    case 'exists':
      return compileExists(node);
    case 'range': {
      const bounds: QueryDsl = {};
      if (node.gte !== undefined) bounds.gte = node.gte;
      if (node.lte !== undefined) bounds.lte = node.lte;
      if (node.gt !== undefined) bounds.gt = node.gt;
      if (node.lt !== undefined) bounds.lt = node.lt;
      return { range: { [node.field.esPath]: bounds } };
    }
  }
}

/**
 * THE authorization wrapper. Every query sent to OpenSearch passes through
 * this function: it injects an unconditional tenantId term filter, an
 * optional case-ACL terms filter (an empty caseIds array matches nothing),
 * and a privilege filter unless the caller may see privileged material.
 */
export function wrapWithAuthorization(query: QueryDsl, auth: AuthContext): QueryDsl {
  if (typeof auth.tenantId !== 'string' || auth.tenantId.length === 0) {
    throw new QueryValidationError(['Authorization context requires a non-empty tenantId']);
  }
  const filter: QueryDsl[] = [{ term: { tenantId: auth.tenantId } }];
  if (auth.caseIds !== null && auth.caseIds !== undefined) {
    filter.push({ terms: { caseIds: auth.caseIds } });
  }
  if (!auth.includePrivileged) {
    filter.push({ term: { privileged: false } });
  }
  return {
    bool: {
      filter,
      must: [query],
    },
  };
}

/** Compile a validated AST into a fully authorized OpenSearch query. */
export function compile(ast: ValidatedAst, auth: AuthContext): QueryDsl {
  return wrapWithAuthorization(compileNode(ast.root), auth);
}

// ---------------------------------------------------------------------------
// Search request building (sort, pagination, highlighting, facets)
// ---------------------------------------------------------------------------

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

const SORT_FIELDS: Record<string, string> = {
  primarydate: 'dates.primary',
  name: 'name.keyword',
  size: 'size',
  indexedat: 'indexedAt',
  received: 'dates.received',
  sent: 'dates.sent',
  score: '_score',
};

export const FACET_FIELDS: Record<string, string> = {
  custodianEmail: 'custodianEmail',
  extension: 'extension',
  provider: 'provider',
  tagNames: 'tagNames',
  kind: 'kind',
  malwareStatus: 'malwareStatus',
};

export interface SearchRequestOptions {
  /** e.g. ['-primaryDate', 'name']; '-' prefix means descending. */
  sort?: string[];
  searchAfter?: (string | number)[];
  /** Page size, clamped to MAX_PAGE_SIZE. */
  limit?: number;
  highlight?: boolean;
  facets?: string[];
}

export interface SearchRequestBody {
  query: QueryDsl;
  size: number;
  sort: QueryDsl[];
  track_total_hits: boolean;
  search_after?: (string | number)[];
  highlight?: QueryDsl;
  aggs?: QueryDsl;
}

function buildSort(sort: string[] | undefined): QueryDsl[] {
  const specs: QueryDsl[] = [];
  for (const raw of sort ?? []) {
    const descending = raw.startsWith('-');
    const name = (descending ? raw.slice(1) : raw).toLowerCase();
    const path = SORT_FIELDS[name];
    if (!path) {
      throw new QueryValidationError([
        `Unknown sort field "${raw}". Allowed: ${Object.keys(SORT_FIELDS).join(', ')}`,
      ]);
    }
    specs.push({ [path]: { order: descending ? 'desc' : 'asc' } });
  }
  if (specs.length === 0) {
    specs.push({ _score: { order: 'desc' } });
  }
  // Deterministic tiebreaker so search_after pagination is stable.
  specs.push({ evidenceItemId: { order: 'asc' } });
  return specs;
}

const HIGHLIGHT_CONFIG: QueryDsl = {
  pre_tags: ['<mark>'],
  post_tags: ['</mark>'],
  fields: {
    'text.*': {},
    'email.subject': {},
    name: {},
  },
};

/**
 * Build a complete OpenSearch request body. The query inside is always the
 * output of `compile`, i.e. always authorization-wrapped.
 */
export function buildSearchRequest(
  ast: ValidatedAst,
  auth: AuthContext,
  opts: SearchRequestOptions = {},
): SearchRequestBody {
  const size = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const body: SearchRequestBody = {
    query: compile(ast, auth),
    size,
    sort: buildSort(opts.sort),
    track_total_hits: true,
  };

  if (opts.searchAfter !== undefined) {
    body.search_after = opts.searchAfter;
  }
  if (opts.highlight === true) {
    body.highlight = HIGHLIGHT_CONFIG;
  }
  if (opts.facets && opts.facets.length > 0) {
    const aggs: QueryDsl = {};
    for (const facet of opts.facets) {
      const path = FACET_FIELDS[facet];
      if (!path) {
        throw new QueryValidationError([
          `Unknown facet "${facet}". Allowed: ${Object.keys(FACET_FIELDS).join(', ')}`,
        ]);
      }
      aggs[facet] = { terms: { field: path, size: 25 } };
    }
    body.aggs = aggs;
  }

  return body;
}
