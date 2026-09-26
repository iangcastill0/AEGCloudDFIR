import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildSearchRequest,
  managerSelectionAuth,
  MAX_PAGE_SIZE,
  type AuthContext as SearchAuthContext,
  type SearchAdapter,
  type ValidatedAst,
} from '@aeg-clouddfir/search';
import { TenantRole, withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import { PRISMA, SEARCH_ADAPTER } from '../common/tokens.js';
import type { AuthContext } from '../common/http.js';
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
 * productions. Managers stay tenant-wide and see privileged material — callers
 * still gate who may trigger a resolution — but forensic-import ACL is the
 * same fence Review already applies. SYSTEM search here used to hand another
 * case_manager the native bytes of an unattached import.
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
    searchAuth: SearchAuthContext,
    validated: ValidatedAst,
    cap: number = SELECTION_ID_CAP,
  ): Promise<string[]> {
    const ids: string[] = [];
    let searchAfter: (string | number)[] | undefined;
    for (;;) {
      const body = buildSearchRequest(validated, searchAuth, {
        limit: MAX_PAGE_SIZE,
        searchAfter,
      });
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
    auth: AuthContext,
    savedSearchId: string,
    cap: number = SELECTION_ID_CAP,
  ): Promise<string[]> {
    const saved = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.savedSearch.findFirst({ where: { id: savedSearchId, tenantId: auth.tenantId } }),
    );
    if (!saved) throw new NotFoundException();
    const validated = this.search.validateStoredAst(saved.queryAst);
    return this.collectIdsForAst(await this.selectionAuth(auth), validated, cap);
  }

  /** Total match count for a saved search without collecting ids. */
  async countForSavedSearch(auth: AuthContext, savedSearchId: string): Promise<number> {
    const saved = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.savedSearch.findFirst({ where: { id: savedSearchId, tenantId: auth.tenantId } }),
    );
    if (!saved) throw new NotFoundException();
    const validated = this.search.validateStoredAst(saved.queryAst);
    return this.countForAst(await this.selectionAuth(auth), validated);
  }

  /** Total match count for an AST without collecting ids (cheap count). */
  async countForAst(searchAuth: SearchAuthContext, validated: ValidatedAst): Promise<number> {
    const body = buildSearchRequest(validated, searchAuth, { limit: 1 });
    const page = await this.adapter.search(body);
    return page.total;
  }

  private async selectionAuth(auth: AuthContext): Promise<SearchAuthContext> {
    const base = await this.search.buildSearchAuth(auth);
    return managerSelectionAuth(auth.tenantId, {
      userId: auth.userId,
      isOrgAdmin: auth.roles.includes(TenantRole.org_admin),
      memberCaseIds: base.importAccess?.caseIds ?? [],
    });
  }
}
