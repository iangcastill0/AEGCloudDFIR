import { describe, expect, it } from 'vitest';
import type { ImportSearchHit } from '@aeg-clouddfir/contracts';
import {
  flattenImportSearchPages,
  importSearchStatus,
  selectImportSearchArtifact,
} from './import-search';

const hit = (id: string, snippet: string): ImportSearchHit => ({
  artifact: {
    id,
    parentId: null,
    evidenceItemId: id,
    path: `logs/${id}.log`,
    name: `${id}.log`,
    kind: 'file',
    mimeType: 'text/plain',
    size: '10',
    sha256: 'a'.repeat(64),
    viewerType: 'log',
    metadata: {},
  },
  matchLocation: 'content',
  snippet,
});

describe('import search view state', () => {
  it('flattens cursor pages and keeps snippets keyed to viewer selections', () => {
    const flattened = flattenImportSearchPages([
      { items: [hit('55555555-5555-4555-8555-555555555555', 'first login')], nextCursor: 'next' },
      { items: [hit('66666666-6666-4666-8666-666666666666', 'second login')], nextCursor: null },
    ]);
    expect(flattened.artifacts.map((item) => item.id)).toEqual([
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ]);
    expect(flattened.snippets.get('66666666-6666-4666-8666-666666666666')).toBe('second login');
  });

  it('reports empty, exact, and paged result states honestly', () => {
    expect(importSearchStatus(0, false)).toBe('No matching files.');
    expect(importSearchStatus(2, false)).toBe('2 matching files.');
    expect(importSearchStatus(100, true)).toBe('Showing 100 matching files. More are available.');
  });

  it('uses the clicked search artifact id to open the existing viewer', () => {
    expect(selectImportSearchArtifact('55555555-5555-4555-8555-555555555555')).toBe(
      '55555555-5555-4555-8555-555555555555',
    );
  });
});
