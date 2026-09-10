import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIELD_REGISTRY,
  MAX_PAGE_SIZE,
  parseQuery,
  validateAst,
  type SearchAdapter,
} from '@aeg-clouddfir/search';
import type { PrismaClient } from '@aeg-clouddfir/database';
import { SelectionService, SelectionTooLargeError } from './selection.service.js';
import type { SearchService } from './search.service.js';

const TENANT = '00000000-0000-4000-8000-00000000aaaa';

/**
 * A search index holding `total` matching documents, answered a page at a time
 * through search_after — the same shape the real adapter uses.
 */
function adapterWith(total: number): SearchAdapter {
  let served = 0;
  return {
    search: (req: { size: number }) => {
      const size = Math.min(req.size, total - served);
      const items = Array.from({ length: Math.max(size, 0) }, (_, i) => ({
        id: `00000000-0000-4000-8000-${(served + i).toString(16).padStart(12, '0')}`,
      }));
      served += items.length;
      return Promise.resolve({
        items,
        total,
        searchAfter: served < total ? ['cursor', served] : undefined,
      });
    },
  } as unknown as SearchAdapter;
}

function service(total: number): SelectionService {
  return new SelectionService(
    {} as unknown as PrismaClient,
    adapterWith(total),
    {} as unknown as SearchService,
  );
}

/** A real validated AST — buildSearchRequest reads its internals. */
const AST = validateAst(parseQuery('body CONTAINS anything'), DEFAULT_FIELD_REGISTRY);

describe('SelectionService.collectIdsForAst', () => {
  it('collects every match, past any single page', async () => {
    // search_after paging, so OpenSearch's 10,000 max_result_window does not
    // apply — deep selections must still come back whole.
    const ids = await service(MAX_PAGE_SIZE * 3 + 7).collectIdsForAst(TENANT, AST);
    expect(ids).toHaveLength(MAX_PAGE_SIZE * 3 + 7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('collects a selection far larger than the old 50,000 cap', async () => {
    const ids = await service(60_000).collectIdsForAst(TENANT, AST);
    expect(ids).toHaveLength(60_000);
  });

  it('THROWS past the guard instead of silently returning a short list', async () => {
    // The behaviour this replaces: a search matching 60,000 items returned
    // exactly 50,000 with no error and no marker, so the export looked
    // complete. In an evidence tool a silent gap is worse than a failure —
    // nothing downstream can tell that anything is missing.
    await expect(service(1_500).collectIdsForAst(TENANT, AST, 1_000)).rejects.toBeInstanceOf(
      SelectionTooLargeError,
    );
  });

  it('says what to do when it refuses', async () => {
    const err = await service(1_500)
      .collectIdsForAst(TENANT, AST, 1_000)
      .catch((e: unknown) => e as Error);
    expect(err.message).toContain('1,000');
    expect(err.message).toContain('Narrow the search');
    // The operator must know nothing partial was produced.
    expect(err.message).toContain('nothing was exported');
  });

  it('does not throw when the match count exactly equals the guard', async () => {
    // Off-by-one here would reject a legitimate selection.
    const ids = await service(1_000).collectIdsForAst(TENANT, AST, 1_000);
    expect(ids).toHaveLength(1_000);
  });
});
