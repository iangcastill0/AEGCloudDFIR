export type {
  BatesRecord,
  EmailAddress,
  EvidenceDates,
  EvidenceEmailFields,
  EvidenceKind,
  EvidenceSearchDoc,
  EvidenceTag,
  OcrPage,
  RawHeader,
} from './document.js';

export { QuerySyntaxError, QueryValidationError } from './errors.js';

export { buildAliasName, buildIndexName, EVIDENCE_MAPPING, MAPPING_VERSION } from './mapping.js';

export {
  ALL_TEXT_FIELDS,
  ALL_TEXT_PATH,
  DEFAULT_FIELD_REGISTRY,
  DEFAULT_TEXT_FIELD,
  FieldRegistry,
  HASH_FIELD_NAMES,
} from './fields.js';
export type { FieldDef, FieldType, ResolvedField } from './fields.js';

export { DEFAULT_FUZZY_EDITS, tokenize } from './lexer.js';
export type { ComparisonOp, Token } from './lexer.js';

export { astFromBuilder, parseQuery } from './parser.js';
export { ADVANCED_PARAMETERS, parseAdvancedQuery } from './advanced.js';
export type {
  BoolNode,
  BuilderQuery,
  ExistsNode,
  MatchAllNode,
  NotNode,
  PhraseNode,
  QueryNode,
  RangeNode,
  TermNode,
  WildcardNode,
} from './parser.js';

export { DEFAULT_COST_LIMITS, parseDateValue, parseSizeValue, validateAst } from './validate.js';
export type { CostLimits, ValidatedAst, ValidatedNode } from './validate.js';

export {
  buildSearchRequest,
  compile,
  compileNode,
  DEFAULT_PAGE_SIZE,
  FACET_FIELDS,
  MAX_PAGE_SIZE,
  wrapWithAuthorization,
} from './compile.js';
export type { AuthContext, QueryDsl, SearchRequestBody, SearchRequestOptions } from './compile.js';

export { OpenSearchAdapter } from './adapter.js';
export type {
  BulkIndexResult,
  BulkItemResult,
  BulkResponseBody,
  FacetBucket,
  MinimalOpenSearchClient,
  OpenSearchAdapterOptions,
  OsApiResponse,
  RawSearchBody,
  RawSearchHit,
  SearchAdapter,
  SearchHit,
  SearchResponse,
} from './adapter.js';
