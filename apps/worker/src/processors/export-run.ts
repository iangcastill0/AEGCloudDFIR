import { PassThrough, Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import {
  appendAuditEvent,
  FAMILY_RELATIONSHIP_KINDS,
  withTenantContext,
  type Prisma,
} from '@aeg-clouddfir/database';
import { Sha256Stream, canonicalJson, sanitizeFilename } from '@aeg-clouddfir/evidence';
import { ProductionArchiveWriter, csvEscape } from '@aeg-clouddfir/production';
import { AUDIT_CSV_COLUMNS, auditRowsFor } from './audit-csv.js';
import {
  DEFAULT_FIELD_REGISTRY,
  buildSearchRequest,
  validateAst,
  type QueryNode,
} from '@aeg-clouddfir/search';
import { sanitizeError, type WorkerContext } from '../context.js';
import { QUERY_ID_CHUNK, chunkIds, queryInChunks } from '../chunked.js';
import type { ExportRunPayload } from './payloads.js';

/**
 * Frozen Export.parameters shape (written by apps/api from
 * createExportRequest): selection + includeFamilies + csv + archiveSplitMb.
 */
const exportParameters = z.object({
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('items'), evidenceItemIds: z.array(z.string().uuid()).min(1) }),
    z.object({ kind: z.literal('tag'), tagId: z.string().uuid() }),
    z.object({ kind: z.literal('saved_search'), savedSearchId: z.string().uuid() }),
    z.object({ kind: z.literal('case'), caseId: z.string().uuid() }),
  ]),
  includeFamilies: z.boolean().default(true),
  csv: z
    .object({
      columns: z.array(z.string()).min(1),
      delimiter: z.enum([',', '\t']).default(','),
    })
    .optional(),
  archiveSplitMb: z.number().int().min(64).max(10_240).default(2048),
});
type ExportParameters = z.infer<typeof exportParameters>;

/**
 * Runaway guard, NOT a product limit. At 50,000 this silently truncated, so a
 * saved search matching more than that produced an export that looked complete
 * and was not. An export missing evidence nobody was told about is the one
 * outcome this product must never produce.
 */
const SAVED_SEARCH_RESULT_CAP = 1_000_000;
const FAMILY_KINDS = FAMILY_RELATIONSHIP_KINDS;

/**
 * The kinds that put a child in its parent's directory. Deliberately narrower
 * than FAMILY_KINDS: family expansion decides what gets EXPORTED, this decides
 * where a file LANDS in the archive, and they are not the same question.
 */
const ATTACHMENT_KINDS = ['attachment', 'inline_attachment'] as const;

/**
 * Splitter decision, factored out for unit testing: start a new archive part
 * when the current one is non-empty and the next item would push it past the
 * split threshold. A single oversized item still goes into its own part.
 */
export function shouldStartNewArchive(
  bytesInCurrent: number,
  nextItemSize: number,
  splitBytes: number,
): boolean {
  return bytesInCurrent > 0 && bytesInCurrent + nextItemSize > splitBytes;
}

export interface ArchiveWriterLike {
  append(path: string, source: Buffer | Readable | string): void;
  finalize(): Promise<{ entryCount: number }>;
}

export interface ExportDeps {
  createArchive?: (output: Writable) => ArchiveWriterLike;
}

/** CSV export column registry — the honest field vocabulary for exports. */
type ExportRow = Record<string, string>;
export const EXPORT_CSV_COLUMNS: readonly string[] = [
  'evidenceItemId',
  'kind',
  'name',
  'extension',
  'mimeType',
  'size',
  'sha256',
  'custodianEmail',
  'collectionId',
  'sourcePath',
  'sourceLabels',
  'primaryDate',
  'acquiredAt',
  'subject',
  'messageId',
  'sentAt',
  'receivedAt',
  'bccPresent',
  'processingStatus',
  'malwareStatus',
  'isApiExportDerivative',
  'tags',
  // Audit events. Only ever filled for audit_batch items, which expand to one
  // row per event rather than one row per page.
  ...AUDIT_CSV_COLUMNS,
];

async function resolveSelectionIds(
  ctx: WorkerContext,
  tenantId: string,
  params: ExportParameters,
): Promise<string[]> {
  const selection = params.selection;
  if (selection.kind === 'items') return [...new Set(selection.evidenceItemIds)];
  if (selection.kind === 'tag') {
    const rows = await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.tagAssignment.findMany({
        where: { tagId: selection.tagId },
        select: { evidenceItemId: true },
      }),
    );
    return [...new Set(rows.map((r) => r.evidenceItemId))];
  }
  if (selection.kind === 'case') {
    const rows = await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.caseItem.findMany({
        where: { caseId: selection.caseId },
        select: { evidenceItemId: true },
      }),
    );
    return [...new Set(rows.map((r) => r.evidenceItemId))];
  }
  // saved_search: run the stored, pre-validated AST through the search
  // adapter with a search_after loop (capped).
  const saved = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.savedSearch.findUnique({ where: { id: selection.savedSearchId } }),
  );
  if (saved === null) throw new Error('saved search referenced by the export no longer exists');
  const validated = validateAst(saved.queryAst as unknown as QueryNode, DEFAULT_FIELD_REGISTRY);
  const ids: string[] = [];
  let searchAfter: (string | number)[] | undefined;
  while (ids.length < SAVED_SEARCH_RESULT_CAP) {
    const request = buildSearchRequest(
      validated,
      { tenantId, includePrivileged: true },
      { limit: 100, searchAfter },
    );
    const page = await ctx.search.search(request);
    if (page.items.length === 0) break;
    for (const hit of page.items) ids.push(hit.id);
    if (page.searchAfter === undefined) break;
    searchAfter = page.searchAfter;
  }
  if (ids.length > SAVED_SEARCH_RESULT_CAP) {
    throw new Error(
      `saved search matched more than ${String(SAVED_SEARCH_RESULT_CAP)} items; ` +
        `refusing to export a truncated set`,
    );
  }
  return [...new Set(ids)];
}

/** Exported for tests: the transaction-per-batch behaviour is the whole point. */
export async function expandFamilies(
  ctx: WorkerContext,
  tenantId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return ids;
  const expanded = new Set(ids);
  // Chunked, and at half the usual size: this query names every id TWICE, so
  // an unchunked call on a 43,379-item case is 86,758 bind variables and dies
  // before the export writes anything.
  //
  // A transaction PER BATCH, not one around the loop. Chunking alone fixed the
  // bind-variable ceiling and left the transaction timeout in place: 434,910
  // ids is 174 round trips, and one interactive transaction is capped at 30
  // seconds, so each had 172 ms to return. It failed at 30,244 ms with
  // `Transaction already closed`. Nothing here writes, so there is no atomicity
  // to give up — this only reads relationships to build a set of ids.
  const relations = await queryInChunks(
    ids,
    (batch) =>
      withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.evidenceRelationship.findMany({
          where: {
            kind: { in: [...FAMILY_KINDS] },
            OR: [{ parentId: { in: batch } }, { childId: { in: batch } }],
          },
          select: { parentId: true, childId: true },
        }),
      ),
    Math.floor(QUERY_ID_CHUNK / 2),
  );
  const parentIds = new Set<string>();
  for (const rel of relations) {
    expanded.add(rel.parentId);
    expanded.add(rel.childId);
    parentIds.add(rel.parentId);
  }
  // Include siblings: all children of every implicated parent.
  const siblings = await queryInChunks([...parentIds], (batch) =>
    withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.evidenceRelationship.findMany({
        where: { kind: { in: [...FAMILY_KINDS] }, parentId: { in: batch } },
        select: { childId: true },
      }),
    ),
  );
  for (const rel of siblings) expanded.add(rel.childId);
  return [...expanded];
}

type LoadedExportItem = Prisma.EvidenceItemGetPayload<{
  include: {
    blob: true;
    custodian: { select: { email: true } };
    emailMetadata: true;
    participants: true;
    tagAssignments: { include: { tag: { select: { name: true } } } };
    childRelationships: { select: { parentId: true; kind: true } };
    // Only ever populated for audit_batch items; every other kind loads none.
    auditRecords: true;
  };
}>;

/**
 * The only two family facts the archive layout needs.
 *
 * `archivePathFor` asked the loaded item list exactly two questions: "does
 * anything here call me its parent?" and "what is my parent called?". It
 * answered the first by scanning the WHOLE list, once per item. That is
 * quadratic: at 434,910 items it is roughly 1.9e11 comparisons, so the export
 * stops making progress rather than failing outright. It never showed before
 * because the largest export that got this far was 43,379 items — a hundred
 * times smaller, and this cost grows with the square, so ten thousand times
 * cheaper.
 *
 * Both answers are precomputed once, so naming one item's path no longer
 * depends on how many items the export has.
 */
export interface FamilyIndex {
  /** Ids that an exported attachment points at. */
  parents: Set<string>;
  /** Parent id -> its name, for parents inside this export only. */
  nameById: Map<string, string>;
}

export async function buildFamilyIndex(
  ctx: WorkerContext,
  tenantId: string,
  ids: string[],
): Promise<FamilyIndex> {
  if (ids.length === 0) return { parents: new Set(), nameById: new Map() };

  // Chunked, one transaction per batch, for the same reasons as expandFamilies.
  const relations = await queryInChunks(ids, (batch) =>
    withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.evidenceRelationship.findMany({
        where: { kind: { in: [...ATTACHMENT_KINDS] }, childId: { in: batch } },
        select: { parentId: true },
      }),
    ),
  );
  const parents = new Set(relations.map((r) => r.parentId));

  // Names, and only for parents that are themselves in the export. A parent
  // outside the selection was never in the old map either, so it keeps the
  // same 'family' fallback and is not worth a query.
  const inExport = new Set(ids);
  const named = await queryInChunks(
    [...parents].filter((id) => inExport.has(id)),
    (batch) =>
      withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.evidenceItem.findMany({
          where: { id: { in: batch } },
          select: { id: true, name: true },
        }),
      ),
  );
  return { parents, nameById: new Map(named.map((i) => [i.id, i.name])) };
}

/**
 * Yield the export's items one batch at a time, in id order.
 *
 * The whole list used to be materialised before a byte was written: 434,910
 * items, each with seven nested includes, in one array — plus a Map holding
 * every one of them a second time. Streaming keeps a single batch alive.
 *
 * Sorting the ids up front is what makes that safe. Every id in batch N sorts
 * below every id in batch N+1 and each batch is asked for `orderBy: id`, so
 * the batches arrive in the stable global order the writers rely on. That also
 * retires the full in-memory sort that used to follow the load.
 */
export async function* loadItemsInBatches(
  ctx: WorkerContext,
  tenantId: string,
  ids: string[],
): AsyncGenerator<LoadedExportItem[]> {
  for (const batch of chunkIds([...ids].sort())) {
    yield await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.evidenceItem.findMany({
        where: { id: { in: batch } },
        include: {
          blob: true,
          custodian: { select: { email: true } },
          emailMetadata: true,
          participants: true,
          tagAssignments: { include: { tag: { select: { name: true } } } },
          childRelationships: { select: { parentId: true, kind: true } },
          // Ordered so the CSV reads as a timeline rather than in whatever
          // order the rows happen to come back.
          auditRecords: { orderBy: [{ occurredAt: 'asc' }, { providerRecordId: 'asc' }] },
        },
        orderBy: { id: 'asc' },
      }),
    );
  }
}

function participantList(item: LoadedExportItem, role: string): string {
  return item.participants
    .filter((p) => p.role === role)
    .map((p) => (p.rawAddress !== '' ? p.rawAddress : p.rawName))
    .filter((v) => v !== '')
    .join('; ');
}

function csvRowFor(item: LoadedExportItem): ExportRow {
  return {
    evidenceItemId: item.id,
    kind: item.kind,
    name: item.name,
    extension: item.extension,
    mimeType: item.mimeType,
    size: String(item.size),
    sha256: item.sha256,
    custodianEmail: item.custodian?.email ?? '',
    collectionId: item.collectionId ?? '',
    sourcePath: item.sourcePath,
    sourceLabels: item.sourceLabels.join('; '),
    primaryDate: item.primaryDate?.toISOString() ?? '',
    acquiredAt: item.acquiredAt.toISOString(),
    subject: item.emailMetadata?.subject ?? '',
    messageId: item.emailMetadata?.messageId ?? '',
    sentAt: item.emailMetadata?.sentAt?.toISOString() ?? '',
    receivedAt: item.emailMetadata?.receivedAt?.toISOString() ?? '',
    bccPresent: item.emailMetadata !== null ? String(item.emailMetadata.bccPresent) : '',
    processingStatus: item.processingStatus,
    malwareStatus: item.malwareStatus,
    isApiExportDerivative: String(item.isApiExportDerivative),
    tags: item.tagAssignments.map((a) => a.tag.name).join('; '),
    from: participantList(item, 'from'),
    to: participantList(item, 'to'),
    cc: participantList(item, 'cc'),
  };
}

interface ManifestEntry {
  evidenceItemId: string;
  archivePath: string;
  archivePart: number;
  sha256: string;
  size: number;
  custodianEmail: string;
  custodianId: string;
  collectionId: string;
  verified: boolean;
  error: string;
}

/**
 * export.run: assemble a native (ZIP) or CSV export with per-item hash
 * verification, split archives, and a canonical manifest. Item-level hash
 * mismatches mark the item failed and continue; only systemic errors fail the
 * export.
 */
export async function processExportRun(
  ctx: WorkerContext,
  payload: ExportRunPayload,
  deps: ExportDeps = {},
): Promise<void> {
  const { tenantId, exportId } = payload;
  const createArchive =
    deps.createArchive ?? ((output: Writable) => new ProductionArchiveWriter(output));

  const exportRow = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.export.findUnique({ where: { id: exportId } }),
  );
  if (exportRow === null) {
    ctx.log.warn({ exportId }, 'export: not found; dropping');
    return;
  }
  if (['ready', 'failed', 'cancelled'].includes(exportRow.status)) return; // idempotent

  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.export.update({ where: { id: exportId }, data: { status: 'running', statusDetail: '' } }),
  );

  try {
    const params = exportParameters.parse(exportRow.parameters);
    let ids = await resolveSelectionIds(ctx, tenantId, params);
    if (params.includeFamilies) {
      ids = await expandFamilies(ctx, tenantId, ids);
    }
    // Streamed, a batch at a time, chunked and with one transaction per batch:
    // `ids` is a whole case or collection and has no upper bound. Holding all
    // of them is what made a 434,910-item export a memory problem as well as a
    // timeout. Reading across separate snapshots is safe because evidence is
    // write-once — the rows an export reads do not change under it.
    let result: ExportResult;
    if (exportRow.kind === 'csv') {
      result = await runCsvExport(
        ctx,
        tenantId,
        exportId,
        params,
        loadItemsInBatches(ctx, tenantId, ids),
      );
    } else {
      // Built before the stream starts, so the archive layout is decided from
      // the whole selection rather than from whichever batch is in hand.
      const family = await buildFamilyIndex(ctx, tenantId, ids);
      result = await runNativeExport(
        ctx,
        tenantId,
        exportId,
        params,
        loadItemsInBatches(ctx, tenantId, ids),
        family,
        createArchive,
      );
    }

    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.export.update({
        where: { id: exportId },
        data: { status: 'verifying' },
      });
      await tx.export.update({
        where: { id: exportId },
        data: {
          status: 'ready',
          verifiedAt: new Date(),
          itemCount: result.itemCount,
          totalBytes: BigInt(result.totalBytes),
          outputPrefix: result.outputPrefix,
          manifestSha256: result.manifestSha256,
          statusDetail: exportStatusDetail(result.itemCount, result.failedCount),
        },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'export.completed',
        targetType: 'export',
        targetId: exportId,
        actorDisplay: 'worker',
        summary: {
          kind: exportRow.kind,
          itemCount: result.itemCount,
          failedCount: result.failedCount,
          totalBytes: result.totalBytes,
          archiveParts: result.archiveParts,
          manifestSha256: result.manifestSha256,
        },
      });
    });
  } catch (err) {
    const message = sanitizeError(err);
    ctx.log.error({ exportId, err: message }, 'export: run failed');
    await withTenantContext(ctx.prisma, tenantId, async (tx) => {
      await tx.export.update({
        where: { id: exportId },
        data: { status: 'failed', statusDetail: message },
      });
      await appendAuditEvent(tx, {
        tenantId,
        action: 'export.failed',
        targetType: 'export',
        targetId: exportId,
        actorDisplay: 'worker',
        summary: { error: message },
      });
    });
  }
}

interface ExportResult {
  itemCount: number;
  failedCount: number;
  totalBytes: number;
  outputPrefix: string;
  manifestSha256: string;
  archiveParts: number;
}

async function runCsvExport(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  params: ExportParameters,
  batches: AsyncIterable<LoadedExportItem[]>,
): Promise<ExportResult> {
  const requested = params.csv?.columns ?? [...EXPORT_CSV_COLUMNS];
  const delimiter = params.csv?.delimiter ?? ',';
  const columns = requested.filter(
    (c) => EXPORT_CSV_COLUMNS.includes(c) || ['from', 'to', 'cc'].includes(c),
  );
  if (columns.length === 0) throw new Error('no valid CSV columns selected');

  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c, { delimiter })).join(delimiter));
  let itemCount = 0;
  for await (const batch of batches) {
    for (const item of batch) {
      itemCount += 1;
      // An audit batch is a page of up to 1,000 events. One row for the page
      // would answer none of the questions a reviewer asks of an audit log, so
      // it expands; everything else stays one row per item.
      const rows =
        item.kind === 'audit_batch'
          ? auditRowsFor(
              { id: item.id, kind: item.kind, sha256: item.sha256, name: item.name },
              item.auditRecords ?? [],
            ).map((auditRow) => ({ ...csvRowFor(item), ...auditRow }))
          : [csvRowFor(item)];
      for (const row of rows) {
        lines.push(columns.map((c) => csvEscape(row[c] ?? '', { delimiter })).join(delimiter));
      }
    }
  }
  const csv = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  const put = await ctx.store.putDerivative(
    tenantId,
    exportId,
    'export-csv',
    1,
    'export.csv',
    csv,
    'text/csv; charset=utf-8',
  );
  return {
    itemCount,
    failedCount: 0,
    totalBytes: csv.byteLength,
    outputPrefix: put.objectKey,
    manifestSha256: put.sha256,
    archiveParts: 0,
  };
}

/**
 * What the operator is told about a finished export.
 *
 * An export that produced NOTHING used to read exactly like one that worked:
 * status "ready", no detail, itemCount 0. A real run against a tag with no
 * items assigned did precisely that, and the only way to tell was to notice
 * the zero. In a product whose failure mode is "reports success, silently
 * broken", an empty archive must say so out loud.
 */
export function exportStatusDetail(itemCount: number, failedCount: number): string {
  if (itemCount === 0) {
    return 'No items matched this selection, so the export is empty. Check that the tag, case or search you chose still contains items.';
  }
  if (failedCount > 0) return `${String(failedCount)} item(s) failed verification`;
  return '';
}

async function runNativeExport(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  params: ExportParameters,
  batches: AsyncIterable<LoadedExportItem[]>,
  family: FamilyIndex,
  createArchive: (output: Writable) => ArchiveWriterLike,
): Promise<ExportResult> {
  const splitBytes = params.archiveSplitMb * 1024 * 1024;
  const manifestEntries: ManifestEntry[] = [];
  const usedPaths = new Set<string>();

  // Family directory naming: children live under their parent's directory.
  // Both lookups are O(1) against the prebuilt index. They used to scan the
  // full item list, which is why a large export stopped making progress.
  const archivePathFor = (item: LoadedExportItem): string => {
    const custodianDir = sanitizeFilename(item.custodian?.email ?? 'unassigned');
    const rel = item.childRelationships.find(
      (r) => r.kind === 'attachment' || r.kind === 'inline_attachment',
    );
    let familyDir = '';
    if (rel !== undefined) {
      const parentName = family.nameById.get(rel.parentId) ?? 'family';
      familyDir = `${sanitizeFilename(parentName)}-${rel.parentId.slice(0, 8)}`;
    } else if (family.parents.has(item.id)) {
      familyDir = `${sanitizeFilename(item.name)}-${item.id.slice(0, 8)}`;
    }
    const fileName = sanitizeFilename(
      item.kind === 'email' && !item.name.endsWith('.eml') ? `${item.name}.eml` : item.name,
    );
    let candidate = ['custodian', custodianDir, familyDir, fileName]
      .filter((p) => p !== '')
      .join('/');
    if (usedPaths.has(candidate)) {
      candidate = candidate.replace(/(\.[^./]+)?$/, `_${item.id.slice(0, 8)}$1`);
    }
    usedPaths.add(candidate);
    return candidate;
  };

  let partNumber = 1;
  let bytesInPart = 0;
  let totalBytes = 0;
  let failedCount = 0;
  let written = 0;

  let output = new PassThrough();
  let upload = ctx.store.putDerivative(
    tenantId,
    exportId,
    'archive',
    partNumber,
    `export-part${String(partNumber).padStart(3, '0')}.zip`,
    output,
    'application/zip',
  );
  let writer = createArchive(output);
  let outputPrefix = '';

  const rotatePart = async (): Promise<void> => {
    await writer.finalize();
    const done = await upload;
    outputPrefix = outputPrefix === '' ? done.objectKey : outputPrefix;
    partNumber += 1;
    bytesInPart = 0;
    output = new PassThrough();
    upload = ctx.store.putDerivative(
      tenantId,
      exportId,
      'archive',
      partNumber,
      `export-part${String(partNumber).padStart(3, '0')}.zip`,
      output,
      'application/zip',
    );
    writer = createArchive(output);
  };

  let seen = 0;
  for await (const batch of batches) {
    for (const item of batch) {
      seen += 1;
      const size = Number(item.size);
      const entryPath = archivePathFor(item);
      const entry: ManifestEntry = {
        evidenceItemId: item.id,
        archivePath: entryPath,
        archivePart: partNumber,
        sha256: item.sha256,
        size,
        custodianEmail: item.custodian?.email ?? '',
        custodianId: item.custodianId ?? '',
        collectionId: item.collectionId ?? '',
        verified: false,
        error: '',
      };

      if (item.blob === null || item.sha256 === '') {
        entry.error = 'no preserved native bytes';
        failedCount += 1;
        manifestEntries.push(entry);
        await upsertExportItem(ctx, tenantId, exportId, item.id, entry, 'failed');
        continue;
      }

      if (shouldStartNewArchive(bytesInPart, size, splitBytes)) {
        await rotatePart();
        entry.archivePart = partNumber;
      }

      try {
        const source = await ctx.store.getStream(
          item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
          item.blob.objectKey,
        );
        const hasher = new Sha256Stream();
        const pass = new PassThrough();
        writer.append(entryPath, pass);
        await pipeline(source, hasher, pass);
        const actual = hasher.digestHex();
        if (actual !== item.sha256) {
          // The bytes are already in the archive; record the mismatch honestly
          // and continue — the manifest and ExportItem mark it failed.
          entry.error = `sha256 mismatch: expected ${item.sha256}, streamed ${actual}`;
          failedCount += 1;
          manifestEntries.push(entry);
          await upsertExportItem(ctx, tenantId, exportId, item.id, entry, 'failed');
          continue;
        }
        entry.verified = true;
        bytesInPart += size;
        totalBytes += size;
        written += 1;
        manifestEntries.push(entry);
        await upsertExportItem(ctx, tenantId, exportId, item.id, entry, 'verified');
      } catch (err) {
        entry.error = sanitizeError(err);
        failedCount += 1;
        manifestEntries.push(entry);
        await upsertExportItem(ctx, tenantId, exportId, item.id, entry, 'failed');
      }
    }
  }

  // Manifests and reports live in the FINAL archive part.
  const manifestJson = canonicalJson({
    schema: 'cdfir.export.manifest.v1',
    exportId,
    generatedAt: new Date().toISOString(),
    itemCount: seen,
    verifiedCount: written,
    failedCount,
    items: manifestEntries,
  });
  const manifestCsvLines = [
    [
      'evidenceItemId',
      'archivePath',
      'part',
      'sha256',
      'size',
      'custodianEmail',
      'verified',
      'error',
    ]
      .map((c) => csvEscape(c))
      .join(','),
    ...manifestEntries.map((e) =>
      [
        e.evidenceItemId,
        e.archivePath,
        String(e.archivePart),
        e.sha256,
        String(e.size),
        e.custodianEmail,
        String(e.verified),
        e.error,
      ]
        .map((v) => csvEscape(v))
        .join(','),
    ),
  ];
  const hashlist = manifestEntries
    .filter((e) => e.verified)
    .map((e) => `${e.sha256}  ${e.archivePath}`)
    .join('\n');
  const exceptionsCsv = [
    ['evidenceItemId', 'archivePath', 'error'].map((c) => csvEscape(c)).join(','),
    ...manifestEntries
      .filter((e) => !e.verified)
      .map((e) => [e.evidenceItemId, e.archivePath, e.error].map((v) => csvEscape(v)).join(',')),
  ];
  const readme = [
    'AEG-CloudDFIR native export',
    '===========================',
    '',
    'Verification:',
    '  1. Extract every archive part.',
    '  2. For each row in hashlist.txt, compute SHA-256 of the extracted file',
    '     (e.g. `sha256sum <path>`) and compare with the recorded digest.',
    '  3. manifest.json is canonical JSON; recompute its SHA-256 and compare',
    '     with the value recorded on the export record.',
    '  4. exceptions.csv lists any item that failed hash verification.',
    '',
    TRUTHFULNESS_NOTICES.defensibility,
  ].join('\n');

  writer.append('manifest.json', Buffer.from(manifestJson, 'utf8'));
  writer.append('manifest.csv', Buffer.from(manifestCsvLines.join('\r\n') + '\r\n', 'utf8'));
  writer.append('hashlist.txt', Buffer.from(hashlist + '\n', 'utf8'));
  writer.append('exceptions.csv', Buffer.from(exceptionsCsv.join('\r\n') + '\r\n', 'utf8'));
  writer.append('README.txt', Buffer.from(readme, 'utf8'));
  await writer.finalize();
  const lastUpload = await upload;
  outputPrefix = outputPrefix === '' ? lastUpload.objectKey : outputPrefix;

  // Manifest hash: over the canonical manifest bytes (also inside the zip).
  const manifestPut = await ctx.store.putDerivative(
    tenantId,
    exportId,
    'export-manifest',
    1,
    'manifest.json',
    Buffer.from(manifestJson, 'utf8'),
    'application/json',
  );

  return {
    itemCount: written,
    failedCount,
    totalBytes,
    outputPrefix,
    manifestSha256: manifestPut.sha256,
    archiveParts: partNumber,
  };
}

async function upsertExportItem(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  evidenceItemId: string,
  entry: ManifestEntry,
  state: 'verified' | 'failed',
): Promise<void> {
  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.exportItem.upsert({
      where: { exportId_evidenceItemId: { exportId, evidenceItemId } },
      create: {
        tenantId,
        exportId,
        evidenceItemId,
        archivePath: entry.archivePath,
        sha256: entry.sha256,
        verified: entry.verified,
        state,
        error: entry.error,
      },
      update: {
        archivePath: entry.archivePath,
        sha256: entry.sha256,
        verified: entry.verified,
        state,
        error: entry.error,
      },
    }),
  );
}
