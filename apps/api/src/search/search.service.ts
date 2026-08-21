import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  astFromBuilder,
  buildSearchRequest,
  DEFAULT_FIELD_REGISTRY,
  parseAdvancedQuery,
  parseQuery,
  QuerySyntaxError,
  QueryValidationError,
  validateAst,
  type AuthContext as SearchAuthContext,
  type QueryNode,
  type SearchAdapter,
  type SearchHit,
  type ValidatedAst,
  type ValidatedNode,
} from '@aeg-clouddfir/search';
import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { PRISMA, SEARCH_ADAPTER } from '../common/tokens.js';
import { isCaseRestricted, mayViewPrivileged } from '../common/roles.js';
import { zodValidate } from '../common/zod-validate.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Which language `query` is written in.
 *
 * Defaults to 'simple' so existing clients and saved searches keep working. Both
 * parsers produce the same AST, so this choice cannot affect what a query is
 * allowed to reach — the tenant filter is injected after parsing either way.
 */
export const QUERY_SYNTAXES = ['simple', 'advanced'] as const;

const searchRequestSchema = z.object({
  query: z.string().max(4000).optional(),
  syntax: z.enum(QUERY_SYNTAXES).default('simple'),
  builder: z.unknown().optional(),
  caseId: z.string().uuid().optional(),
  sort: z.array(z.string().max(40)).max(3).optional(),
  searchAfter: z
    .array(z.union([z.string(), z.number()]))
    .max(4)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  facets: z.array(z.string().max(40)).max(6).optional(),
  includeHighlights: z.boolean().optional(),
});

export type SearchRequestInput = z.infer<typeof searchRequestSchema>;

export interface SearchResultDto {
  total: number;
  items: SearchHit[];
  searchAfter: (string | number)[] | null;
  facets: Record<string, { value: string; count: number }[]>;
  tookMs: number;
}

export interface ExplainResultDto {
  fields: string[];
  clauseCount: number;
  highlightTerms: string[];
}

/** Translate query-pipeline errors into 400s with positions/violations. */
function rethrowQueryError(err: unknown): never {
  if (err instanceof QuerySyntaxError) {
    throw new BadRequestException({
      message: err.message,
      position: err.position,
    });
  }
  if (err instanceof QueryValidationError) {
    throw new BadRequestException({
      message: 'query validation failed',
      violations: err.violations,
    });
  }
  throw err;
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every parameter the query language accepts, with its type.
   *
   * `header.<name>` is left out: it is a pattern rather than a field, so it
   * cannot be a dropdown entry.
   */
  searchableFields(): { name: string; type: string }[] {
    return DEFAULT_FIELD_REGISTRY.allowedFields()
      .filter((name) => name !== 'header.<name>')
      .map((name) => ({ name, type: DEFAULT_FIELD_REGISTRY.resolve(name).type }));
  }

  private parseToValidatedAst(input: SearchRequestInput): ValidatedAst {
    try {
      let ast: QueryNode;
      if (typeof input.query === 'string' && input.query.trim().length > 0) {
        ast = parseQuery(input.query);
      } else if (input.builder !== undefined && input.builder !== null) {
        ast = astFromBuilder(input.builder);
      } else {
        // Browse-all: an empty request matches the whole (tenant-scoped)
        // corpus — useful when reviewing an entire collected mailbox. The
        // compiler still injects the tenant/case/privilege filters
        // unconditionally, so this can never widen visibility.
        ast = parseQuery('');
      }
      return validateAst(ast, DEFAULT_FIELD_REGISTRY);
    } catch (err) {
      rethrowQueryError(err);
    }
  }

  /**
   * For saved searches: parse queryText when present (authoritative),
   * otherwise validate the supplied AST. Returns the raw, JSON-serializable
   * QueryNode that passed validation.
   */
  parseOrValidate(
    queryText: string,
    queryAst: unknown,
    syntax: 'simple' | 'advanced' = 'simple',
  ): unknown {
    if (queryText.trim().length > 0) {
      try {
        // The stored syntax matters: parsing an advanced query with the simple
        // parser would either fail or, worse, mean something different.
        const node = syntax === 'advanced' ? parseAdvancedQuery(queryText) : parseQuery(queryText);
        validateAst(node, DEFAULT_FIELD_REGISTRY);
        return node;
      } catch (err) {
        rethrowQueryError(err);
      }
    }
    if (queryAst === undefined || queryAst === null) {
      throw new BadRequestException('either queryText or queryAst is required');
    }
    this.validateStoredAst(queryAst);
    return queryAst;
  }

  /** Validate a stored/user-supplied AST (saved searches). */
  validateStoredAst(ast: unknown): ValidatedAst {
    try {
      return validateAst(ast as QueryNode, DEFAULT_FIELD_REGISTRY);
    } catch (err) {
      if (err instanceof QueryValidationError) rethrowQueryError(err);
      throw new BadRequestException('queryAst is not a valid query AST');
    }
  }

  /** Case ids the caller's memberships grant access to. */
  private async memberCaseIds(auth: AuthContext): Promise<string[]> {
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.caseMember.findMany({
        where: { tenantId: auth.tenantId, membershipId: auth.membershipId },
        select: { caseId: true },
      }),
    );
    return rows.map((r) => r.caseId);
  }

  /**
   * Build the authorization context for the search engine. read_only callers
   * are ALWAYS restricted to their assigned cases (empty list matches
   * nothing); an explicit caseId narrows further after a membership check.
   */
  async buildSearchAuth(auth: AuthContext, caseId?: string): Promise<SearchAuthContext> {
    let caseIds: string[] | null = null;
    if (isCaseRestricted(auth)) {
      const memberCases = await this.memberCaseIds(auth);
      if (caseId !== undefined) {
        if (!memberCases.includes(caseId)) throw new NotFoundException();
        caseIds = [caseId];
      } else {
        caseIds = memberCases;
      }
    } else if (caseId !== undefined) {
      const found = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
        tx.case.findFirst({ where: { id: caseId, tenantId: auth.tenantId }, select: { id: true } }),
      );
      if (!found) throw new NotFoundException();
      caseIds = [caseId];
    }
    return {
      tenantId: auth.tenantId,
      caseIds,
      includePrivileged: mayViewPrivileged(auth),
    };
  }

  async execute(
    auth: AuthContext,
    body: unknown,
    request: FastifyRequest,
  ): Promise<SearchResultDto> {
    const input = zodValidate(searchRequestSchema, body);
    const validated = this.parseToValidatedAst(input);
    const searchAuth = await this.buildSearchAuth(auth, input.caseId);

    let requestBody;
    try {
      requestBody = buildSearchRequest(validated, searchAuth, {
        // Relevance score is meaningless for browse-all; default to newest
        // first so a full-mailbox review reads chronologically.
        sort:
          input.sort ??
          (typeof input.query === 'string' && input.query.trim().length > 0
            ? undefined
            : ['-primaryDate']),
        searchAfter: input.searchAfter,
        limit: input.limit,
        highlight: input.includeHighlights === true,
        facets: input.facets,
      });
    } catch (err) {
      rethrowQueryError(err);
    }

    const startedAt = Date.now();
    const response = await this.adapter.search(requestBody);
    const tookMs = Date.now() - startedAt;

    // Result bodies are NEVER audited; the query text/shape summary is.
    await this.audit.append({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorDisplay: auth.actorDisplay,
      effectiveRoles: auth.roles,
      action: 'search.executed',
      summary: {
        queryLength: input.query?.length ?? 0,
        usedBuilder: input.builder !== undefined,
        total: response.total,
      },
      request,
    });

    return {
      total: response.total,
      items: response.items,
      searchAfter: response.searchAfter ?? null,
      facets: response.facets ?? {},
      tookMs,
    };
  }

  /**
   * Redacted view of the compiled query for the "why this matched" panel:
   * fields + clause count + highlight terms, never raw engine DSL.
   */
  async explain(auth: AuthContext, body: unknown): Promise<ExplainResultDto> {
    const input = zodValidate(searchRequestSchema, body);
    const validated = this.parseToValidatedAst(input);
    // Authorization context is still resolved so a read_only caller cannot
    // probe queries against cases they do not belong to.
    await this.buildSearchAuth(auth, input.caseId);

    const fields = new Set<string>();
    const terms = new Set<string>();
    let clauseCount = 0;

    const walk = (node: ValidatedNode): void => {
      switch (node.kind) {
        case 'and':
        case 'or':
          for (const child of node.children) walk(child);
          return;
        case 'not':
          walk(node.child);
          return;
        case 'match_all':
          return;
        case 'exists':
          clauseCount += 1;
          fields.add(node.field.name);
          return;
        case 'range':
          clauseCount += 1;
          fields.add(node.field.name);
          return;
        case 'term':
        case 'phrase':
        case 'wildcard':
          clauseCount += 1;
          fields.add(node.field.name);
          if (typeof node.value === 'string' && node.value.length > 0) {
            terms.add(node.value);
          }
          return;
      }
    };
    walk(validated.root);

    return {
      fields: [...fields].sort(),
      clauseCount,
      highlightTerms: [...terms],
    };
  }
}
