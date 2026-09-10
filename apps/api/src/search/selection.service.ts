import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildSearchRequest,
  MAX_PAGE_SIZE,
  type SearchAdapter,
  type ValidatedAst,
} from '@aeg-clouddfir/search';
import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import { PRISMA, SEARCH_ADAPTER } from '../common/tokens.js';
import { SearchService } from './search.service.js';

/**
 * Runaway guard on ids collected from a search selection — NOT a product
 * limit.
 *
 * This used to be 50,000 and it silently truncated: a saved search matching
 * 60,000 items produced a 50,000-item export that looked complete. In an
 * evidence tool that is the worst available outcome, worse by far than an
 * error, because nothing downstream can tell that anything is missing.
 *
 * Ids are cheap — a million UUIDs is about 36 MB — so the number is set where
 * it only catches a genuine runaway, and reaching it now THROWS rather than
 * quietly dropping the tail.
 */
export const SELECTION_ID_CAP = 1_000_000;

/** Raised instead of returning a short list. */
export class SelectionTooLargeError extends Error {
  constructor(cap: number) {
    super(
      `selection matched more than ${cap.toLocaleString('en-US')} items, which is past the ` +
        `safety limit. Narrow the search and try again — nothing was exported, ` +
        `deliberately, rather than exporting an incomplete set.`,
    );
    this.name = 'SelectionTooLargeError';
  }
}

/**
 * Resolves saved searches into evidence item id lists for cases, exports and
 * productions. Runs as the SYSTEM: tenant-scoped, no case ACL, privileged
 * items included — callers gate who may trigger a resolution.
 */
@Injectable()
export class SelectionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    private readonly search: SearchService,
  ) {}

  /** Collect every matching evidence item id via search_after paging. */
  async collectIdsForAst(
    tenantId: string,
    validated: ValidatedAst,
    cap: number = SELECTION_ID_CAP,
  ): Promise<string[]> {
    const ids: string[] = [];
    let searchAfter: (string | number)[] | undefined;
    for (;;) {
      const body = buildSearchRequest(
        validated,
        { tenantId, caseIds: null, includePrivileged: true },
        { limit: MAX_PAGE_SIZE, searchAfter },
      );
      const page = await this.adapter.search(body);
      for (const hit of page.items) {
        ids.push(hit.id);
        if (ids.length > cap) throw new SelectionTooLargeError(cap);
      }
      if (page.items.length < MAX_PAGE_SIZE || page.searchAfter === undefined) {
        return ids;
      }
      searchAfter = page.searchAfter;
    }
  }

  /** Load a saved search (404 when missing) and collect its matching ids. */
  async collectIdsForSavedSearch(
    tenantId: string,
    savedSearchId: string,
    cap: number = SELECTION_ID_CAP,
  ): Promise<string[]> {
    const saved = await withTenantContext(this.prisma, tenantId, (tx) =>
      tx.savedSearch.findFirst({ where: { id: savedSearchId, tenantId } }),
    );
    if (!saved) throw new NotFoundException();
    const validated = this.search.validateStoredAst(saved.queryAst);
    return this.collectIdsForAst(tenantId, validated, cap);
  }

  /** Total match count for a saved search without collecting ids. */
  async countForSavedSearch(tenantId: string, savedSearchId: string): Promise<number> {
    const saved = await withTenantContext(this.prisma, tenantId, (tx) =>
      tx.savedSearch.findFirst({ where: { id: savedSearchId, tenantId } }),
    );
    if (!saved) throw new NotFoundException();
    const validated = this.search.validateStoredAst(saved.queryAst);
    return this.countForAst(tenantId, validated);
  }

  /** Total match count for an AST without collecting ids (cheap count). */
  async countForAst(tenantId: string, validated: ValidatedAst): Promise<number> {
    const body = buildSearchRequest(
      validated,
      { tenantId, caseIds: null, includePrivileged: true },
      { limit: 1 },
    );
    const page = await this.adapter.search(body);
    return page.total;
  }
}
