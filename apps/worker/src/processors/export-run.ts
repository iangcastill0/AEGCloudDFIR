import { PassThrough, Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { TRUTHFULNESS_NOTICES } from '@evidencevault/contracts';
import { appendAuditEvent, withTenantContext, type Prisma } from '@evidencevault/database';
import { Sha256Stream, canonicalJson, sanitizeFilename } from '@evidencevault/evidence';
import { ProductionArchiveWriter, csvEscape } from '@evidencevault/production';
import {
  DEFAULT_FIELD_REGISTRY,
  buildSearchRequest,
  validateAst,
  type QueryNode,
} from '@evidencevault/search';
import { sanitizeError, type WorkerContext } from '../context.js';
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

const SAVED_SEARCH_RESULT_CAP = 50_000;
const FAMILY_KINDS = ['attachment', 'inline_attachment'] as const;

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
  return [...new Set(ids)].slice(0, SAVED_SEARCH_RESULT_CAP);
}

async function expandFamilies(
  ctx: WorkerContext,
  tenantId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return ids;
  const expanded = new Set(ids);
  const relations = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceRelationship.findMany({
      where: {
        kind: { in: [...FAMILY_KINDS] },
        OR: [{ parentId: { in: ids } }, { childId: { in: ids } }],
      },
      select: { parentId: true, childId: true },
    }),
  );
  const parentIds = new Set<string>();
  for (const rel of relations) {
    expanded.add(rel.parentId);
    expanded.add(rel.childId);
    parentIds.add(rel.parentId);
  }
  // Include siblings: all children of every implicated parent.
  const siblings = await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.evidenceRelationship.findMany({
      where: { kind: { in: [...FAMILY_KINDS] }, parentId: { in: [...parentIds] } },
      select: { childId: true },
    }),
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
  };
}>;

function participantList(item: LoadedExportItem, role: string): string {
  return item.participants
    .filter((p) => p.role === role)
    .map((p) => p.rawAddress !== '' ? p.rawAddress : p.rawName)
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
    const items = await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.evidenceItem.findMany({
        where: { id: { in: ids } },
        include: {
          blob: true,
          custodian: { select: { email: true } },
          emailMetadata: true,
          participants: true,
          tagAssignments: { include: { tag: { select: { name: true } } } },
          childRelationships: { select: { parentId: true, kind: true } },
        },
        orderBy: { id: 'asc' },
      }),
    );

    const result =
      exportRow.kind === 'csv'
        ? await runCsvExport(ctx, tenantId, exportId, params, items)
        : await runNativeExport(ctx, tenantId, exportId, params, items, createArchive);

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
          statusDetail:
            result.failedCount > 0 ? `${result.failedCount} item(s) failed verification` : '',
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
  items: LoadedExportItem[],
): Promise<ExportResult> {
  const requested = params.csv?.columns ?? [...EXPORT_CSV_COLUMNS];
  const delimiter = params.csv?.delimiter ?? ',';
  const columns = requested.filter(
    (c) => EXPORT_CSV_COLUMNS.includes(c) || ['from', 'to', 'cc'].includes(c),
  );
  if (columns.length === 0) throw new Error('no valid CSV columns selected');

  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c, { delimiter })).join(delimiter));
  for (const item of items) {
    const row = csvRowFor(item);
    lines.push(columns.map((c) => csvEscape(row[c] ?? '', { delimiter })).join(delimiter));
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
    itemCount: items.length,
    failedCount: 0,
    totalBytes: csv.byteLength,
    outputPrefix: put.objectKey,
    manifestSha256: put.sha256,
    archiveParts: 0,
  };
}

async function runNativeExport(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  params: ExportParameters,
  items: LoadedExportItem[],
  createArchive: (output: Writable) => ArchiveWriterLike,
): Promise<ExportResult> {
  const splitBytes = params.archiveSplitMb * 1024 * 1024;
  const manifestEntries: ManifestEntry[] = [];
  const usedPaths = new Set<string>();

  // Family directory naming: children live under their parent's directory.
  const parentById = new Map(items.map((i) => [i.id, i]));
  const archivePathFor = (item: LoadedExportItem): string => {
    const custodianDir = sanitizeFilename(item.custodian?.email ?? 'unassigned');
    const rel = item.childRelationships.find(
      (r) => r.kind === 'attachment' || r.kind === 'inline_attachment',
    );
    let familyDir = '';
    if (rel !== undefined) {
      const parent = parentById.get(rel.parentId);
      familyDir = `${sanitizeFilename(parent?.name ?? 'family')}-${rel.parentId.slice(0, 8)}`;
    } else if (
      items.some((other) =>
        other.childRelationships.some(
          (r) =>
            (r.kind === 'attachment' || r.kind === 'inline_attachment') && r.parentId === item.id,
        ),
      )
    ) {
      familyDir = `${sanitizeFilename(item.name)}-${item.id.slice(0, 8)}`;
    }
    const fileName = sanitizeFilename(
      item.kind === 'email' && !item.name.endsWith('.eml') ? `${item.name}.eml` : item.name,
    );
    let candidate = ['custodian', custodianDir, familyDir, fileName].filter((p) => p !== '').join('/');
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

  for (const item of items) {
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

  // Manifests and reports live in the FINAL archive part.
  const manifestJson = canonicalJson({
    schema: 'evidencevault.export.manifest.v1',
    exportId,
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    verifiedCount: written,
    failedCount,
    items: manifestEntries,
  });
  const manifestCsvLines = [
    ['evidenceItemId', 'archivePath', 'part', 'sha256', 'size', 'custodianEmail', 'verified', 'error']
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
    'EvidenceVault native export',
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
