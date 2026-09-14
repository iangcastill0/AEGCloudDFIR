import type { ManifestItem } from '@aeg-clouddfir/evidence';

/**
 * Read a collection's manifest items in pages.
 *
 * The whole set used to be loaded by one `findMany` inside one transaction:
 *
 *   const evidenceItems = await withTenantContext(ctx.prisma, tenantId, (tx) =>
 *     tx.evidenceItem.findMany({ where: { collectionId }, include: { blob } }));
 *
 * That works until a collection is large, and then it fails permanently. On a
 * real matter of 434,910 evidence items it took 44-72 seconds against a
 * 30-second transaction limit, so finalize retried every 30 seconds and could
 * never seal:
 *
 *   Transaction already closed: the timeout for this transaction was 30000 ms,
 *   however 72354 ms passed since the start of the transaction.
 *
 * It also held every row, with its blob, in memory at once — the worker went
 * to 5.2 GiB building one manifest.
 *
 * Paging fixes both. Each page is its own short transaction, and rows are
 * mapped to the much smaller ManifestItem straight away so the full Prisma
 * rows are never all live together.
 *
 * Ordered by id, not createdAt. Cursor paging needs a unique, stable sort, and
 * createdAt is neither. The manifest is unaffected: `merkleRoot` hashes a
 * SORTED list, so the integrity anchor does not depend on item order.
 */

/**
 * Rows per page. Small enough that one page is far inside the transaction
 * limit even on a busy host, large enough that a 434,910-item collection is
 * ~218 queries rather than thousands.
 *
 * Measured on the live database: 93 ms per page, an index scan on the primary
 * key with no sort.
 */
export const MANIFEST_PAGE_SIZE = 2_000;

/**
 * Hard stop on how many rows one manifest may walk.
 *
 * The loop below ends when a page comes back short or empty, which depends on
 * the cursor advancing every time. Prisma will always advance it — but this
 * runs in the worker, and a worker that spins forever in silence is worse than
 * one that stops and says why. The real collection that prompted this fix held
 * 434,910 items, so this leaves an order of magnitude of headroom before it
 * ever fires.
 */
export const MANIFEST_ROW_CAP = 5_000_000;

/** Raised when the walk exceeds MANIFEST_ROW_CAP. */
export class ManifestTooLargeError extends Error {
  constructor(cap: number) {
    super(
      `manifest walk read more than ${cap.toLocaleString('en-US')} rows without finishing. ` +
        `Either the collection is larger than this build supports, or the paging cursor ` +
        `stopped advancing. No manifest was written.`,
    );
    this.name = 'ManifestTooLargeError';
  }
}

/** The columns the manifest needs. Mirrors the Prisma select in finalize. */
export interface ManifestItemRow {
  id: string;
  providerItemId: string;
  custodianId: string | null;
  sha256: string;
  size: bigint | number;
  acquiredAt: Date;
  isApiExportDerivative: boolean;
  blob: { objectKey: string } | null;
}

/** Reads one page starting after `cursor` (undefined for the first page). */
export type ReadManifestPage = (
  cursor: string | undefined,
  take: number,
) => Promise<ManifestItemRow[]>;

export function toManifestItem(row: ManifestItemRow): ManifestItem {
  return {
    evidenceItemId: row.id,
    providerItemId: row.providerItemId,
    custodianId: row.custodianId ?? '',
    sha256: row.sha256,
    size: Number(row.size),
    objectKey: row.blob?.objectKey ?? '',
    acquiredAt: row.acquiredAt.toISOString(),
    ...(row.isApiExportDerivative ? { apiExportDerivative: true } : {}),
  };
}

/**
 * Collect every manifest item, a page at a time.
 *
 * Items with no sha256 are left out, exactly as before: an entry with no hash
 * proves nothing, and a manifest is a statement about bytes that were verified.
 */
export async function loadManifestItems(
  readPage: ReadManifestPage,
  pageSize: number = MANIFEST_PAGE_SIZE,
): Promise<ManifestItem[]> {
  const items: ManifestItem[] = [];
  let cursor: string | undefined;
  let rowsRead = 0;

  for (;;) {
    const page = await readPage(cursor, pageSize);
    if (page.length === 0) return items;

    rowsRead += page.length;
    if (rowsRead > MANIFEST_ROW_CAP) throw new ManifestTooLargeError(MANIFEST_ROW_CAP);

    for (const row of page) {
      if (row.sha256 === '') continue;
      items.push(toManifestItem(row));
    }

    // A short page means the end. Reading again would return nothing and cost
    // one more query per collection, every time.
    if (page.length < pageSize) return items;

    const last = page[page.length - 1];
    // Defensive: without a cursor the next call would repeat page one forever.
    if (last === undefined) return items;
    cursor = last.id;
  }
}
