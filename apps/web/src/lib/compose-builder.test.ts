import { describe, expect, it } from 'vitest';
import { composeBuilder } from './hooks';

const BUILT = { op: 'and', children: [{ field: 'body', operator: 'contains', value: 'wire' }] };

function input(overrides: Record<string, unknown> = {}) {
  return {
    queryText: '',
    builder: BUILT,
    facetFilters: {},
    ...overrides,
  } as Parameters<typeof composeBuilder>[0];
}

describe('composeBuilder', () => {
  it('returns the built query untouched when no rail filters are set', () => {
    expect(composeBuilder(input(), BUILT)).toBe(BUILT);
  });

  it('ANDs the custodian filter onto the built query', () => {
    expect(composeBuilder(input({ custodianEmail: ' alice@example.com ' }), BUILT)).toEqual({
      op: 'and',
      children: [BUILT, { field: 'custodian', operator: 'equals', value: 'alice@example.com' }],
    });
  });

  it('turns the email source into kind email OR attachment, like the text path', () => {
    expect(composeBuilder(input({ source: 'email' }), BUILT)).toEqual({
      op: 'and',
      children: [
        BUILT,
        {
          op: 'or',
          children: [
            { field: 'kind', operator: 'equals', value: 'email' },
            { field: 'kind', operator: 'equals', value: 'attachment' },
          ],
        },
      ],
    });
  });

  it('keeps ticked facets — dropping them silently made results look unfiltered', () => {
    const composed = composeBuilder(
      input({ facetFilters: { extension: ['docx', 'pdf'], tagNames: ['hot'] } }),
      BUILT,
    ) as { children: unknown[] };
    expect(composed.children).toEqual([
      BUILT,
      {
        op: 'or',
        children: [
          { field: 'ext', operator: 'equals', value: 'docx' },
          { field: 'ext', operator: 'equals', value: 'pdf' },
        ],
      },
      { field: 'tag', operator: 'equals', value: 'hot' },
    ]);
  });

  it('ignores a facet field with no query field and an empty value list', () => {
    expect(composeBuilder(input({ facetFilters: { nonsense: ['x'], extension: [] } }), BUILT)).toBe(
      BUILT,
    );
  });
});
