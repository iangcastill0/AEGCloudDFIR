import type { ImportSearchHit } from '@aeg-clouddfir/contracts';

interface SearchPage {
  items: ImportSearchHit[];
  nextCursor: string | null;
}

export function flattenImportSearchPages(pages: SearchPage[]): {
  artifacts: ImportSearchHit['artifact'][];
  snippets: Map<string, string>;
} {
  const hits = pages.flatMap((page) => page.items);
  return {
    artifacts: hits.map((hit) => hit.artifact),
    snippets: new Map(hits.map((hit) => [hit.artifact.id, hit.snippet])),
  };
}

export function importSearchStatus(count: number, hasNextPage: boolean): string {
  if (count === 0) return 'No matching files.';
  if (hasNextPage) {
    return `Showing ${String(count)} matching files. More are available.`;
  }
  return `${String(count)} matching file${count === 1 ? '' : 's'}.`;
}

export function selectImportSearchArtifact(artifactId: string): string {
  return artifactId;
}
