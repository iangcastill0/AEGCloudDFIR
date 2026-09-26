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
import {
  Sha256Stream,
  archivePartFilename,
  canonicalJson,
  derivativeTypeFor,
  sanitizeFilename,
} from '@aeg-clouddfir/evidence';
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
import { pstStoreDisplayName, runPstExport, type PstExportItem } from './pst-export.js';
import type { ExportRunPayload } from './payloads.js';

/**
 * Where an email's attachments end up in a native export.
 *
 * `inline` — the default. An `.eml` is RFC822 and already carries its
 * attachments inside it, so writing them out again as separate files puts a
 * second copy of the same bytes in the archive and adds one directory per
 * email. A copy our parser made is a processed artefact, not a native, and a
 * native export is supposed to hand over natives.
 *
 * `extracted` — the old layout, kept rather than deleted. "Give me the loose
 * files" is a real request: some review platforms ingest loose attachments,
 * and anyone re-producing an export they already certified needs the layout
 * they certified. It costs one branch to keep.
 */
const attachmentLayout = z.enum(['inline', 'extracted']);
type AttachmentLayout = z.infer<typeof attachmentLayout>;

/**
 * Frozen Export.parameters shape (written by apps/api from
 * createExportRequest): selection + includeFamilies + attachments + csv +
 * archiveSplitMb.
 *
 * `attachments` defaults to `inline`, so an export row frozen before this
 * existed reads as inline. That only matters for a row still queued or
 * running, because `processExportRun` returns early on one already `ready`.
 */
const exportParameters = z.object({
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('items'), evidenceItemIds: z.array(z.string().uuid()).min(1) }),
    z.object({ kind: z.literal('tag'), tagId: z.string().uuid() }),
    z.object({ kind: z.literal('saved_search'), savedSearchId: z.string().uuid() }),
    z.object({ kind: z.literal('case'), caseId: z.string().uuid() }),
  ]),
  includeFamilies: z.boolean().default(true),
  attachments: attachmentLayout.default('inline'),
  csv: z
    .object({
      columns: z.array(z.string()).min(1),
      delimiter: z.enum([',', '\t']).default(','),
    })
    .optional(),
  archiveSplitMb: z.number().int().min(64).max(10_240).default(2048),
  /**
   * Part size for a `pst` export. Capped at 3 GiB because the writer's own hard
   * ceiling is about 3.19 GiB and it SILENTLY clamps anything larger — see the
   * contract for the full reason.
   */
  pstPartMb: z.number().int().min(64).max(3072).default(3072),
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
 * The kinds whose bytes are already inside the parent's native.
 *
 * Deliberately narrower than FAMILY_KINDS: family expansion decides what gets
 * EXPORTED, this decides whether a child needs its own archive entry at all,
 * and they are not the same question. A `family` relationship links items that
 * belong together; it does NOT mean one contains the other, so those children
 * are always written as their own files.
 */
const ATTACHMENT_KINDS = ['attachment', 'inline_attachment'] as const;

function isAttachmentKind(kind: string): boolean {
  return (ATTACHMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * Native download returns 423 for infected items (org_admin override only).
 * Productions block them as non-overridable. Export used to stream the bytes
 * anyway — from the quarantine bucket, and from shared blobs that stay in
 * evidence. The gate is `malwareStatus`, not `storageClass`.
 */
const INFECTED_NATIVE_EXPORT_ERROR = 'this item is flagged as malware; native export is locked';

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
  /**
   * Parent id -> the archive path that parent's native will occupy.
   *
   * Filled for the `inline` layout only, and only for parents inside this
   * export. It exists because items stream in id order, so an attachment is
   * often reached BEFORE the email it came out of. The child has to record
   * which file it is inside, and it cannot wait for that file to be written.
   * Precomputing the parent's path is what makes the two agree.
   */
  pathById: Map<string, string>;
}

/** The filename a native gets in the archive. Emails gain `.eml` if missing. */
function archiveFileName(item: { kind: string; name: string }): string {
  return sanitizeFilename(
    item.kind === 'email' && !item.name.endsWith('.eml') ? `${item.name}.eml` : item.name,
  );
}

function custodianDir(email: string | null | undefined): string {
  return sanitizeFilename(email ?? 'unassigned');
}

/** Append the id stem before the extension, which is how collisions are broken. */
function withIdSuffix(path: string, id: string): string {
  return path.replace(/(\.[^./]+)?$/, `_${id.slice(0, 8)}$1`);
}

export async function buildFamilyIndex(
  ctx: WorkerContext,
  tenantId: string,
  ids: string[],
  layout: AttachmentLayout,
): Promise<FamilyIndex> {
  if (ids.length === 0) {
    return { parents: new Set(), nameById: new Map(), pathById: new Map() };
  }

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
          select: { id: true, name: true, kind: true, custodian: { select: { email: true } } },
        }),
      ),
  );

  const pathById = new Map<string, string>();
  if (layout === 'inline') {
    // Sorted by id, so the path a parent gets does not depend on the order the
    // database happened to return rows in. A child writes this path into the
    // manifest before the parent is written, so the two must agree every run.
    const taken = new Set<string>();
    for (const parent of [...named].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const base = `custodian/${custodianDir(parent.custodian?.email)}/${archiveFileName(parent)}`;
      const path = taken.has(base) ? withIdSuffix(base, parent.id) : base;
      taken.add(path);
      pathById.set(parent.id, path);
    }
  }

  return { parents, nameById: new Map(named.map((i) => [i.id, i.name])), pathById };
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
  /**
   * `file` — its own entry in the zip, at `archivePath`.
   * `inline` — its bytes are inside `containerPath`, which IS in the zip. It
   * has no `archivePath`, because listing a path the reader cannot extract
   * would be worse than saying plainly that there is not one.
   */
  placement: 'file' | 'inline';
  archivePath: string;
  /** The archive entry that contains this item's bytes. Empty for a file. */
  containerPath: string;
  /** The evidence item whose native contains this one. Empty for a file. */
  containerItemId: string;
  /** For an inline entry, the part its container landed in. */
  archivePart: number;
  sha256: string;
  size: number;
  custodianEmail: string;
  custodianId: string;
  collectionId: string;
  verified: boolean;
  /** Why this item is laid out the way it is, when that is not the default. */
  note: string;
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
    // `includeFamilies` still decides WHAT is exported; `attachments` decides
    // HOW it is laid out. They are separate questions and both still matter.
    //
    // What changed for email: with attachments inline, turning this on adds
    // the parent `.eml` (and therefore every sibling attachment, which is
    // inside it) as ONE extra file, where it used to add N loose files. So it
    // is not a no-op — select one attachment with it off and you get that
    // attachment alone; turn it on and you get the whole message it came from.
    // For non-email families (`family` relationships link items that belong
    // together without one containing the other) nothing at all changed.
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
    } else if (exportRow.kind === 'pst') {
      result = await runPstExportKind(
        ctx,
        tenantId,
        exportId,
        exportRow.name,
        params,
        loadItemsInBatches(ctx, tenantId, ids),
      );
    } else {
      // Built before the stream starts, so the archive layout is decided from
      // the whole selection rather than from whichever batch is in hand.
      const family = await buildFamilyIndex(ctx, tenantId, ids, params.attachments);
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
      // Written in the SAME transaction that marks the export ready. An export
      // that says `ready` without part digests is one a recipient cannot check
      // a download against, and there would be nothing to say so.
      if (result.parts.length > 0) {
        await tx.exportPart.createMany({
          data: result.parts.map((part) => ({
            tenantId,
            exportId,
            partNumber: part.partNumber,
            objectKey: part.objectKey,
            sha256: part.sha256,
            sizeBytes: BigInt(part.sizeBytes),
          })),
          skipDuplicates: true,
        });
      }
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
            exportRow.kind === 'pst'
              ? pstExportStatusDetail(
                  result.itemCount,
                  result.failedCount,
                  result.inlineCount,
                  result.omittedCount,
                )
              : exportStatusDetail(result.itemCount, result.failedCount, result.inlineCount),
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
          inlineAttachmentCount: result.inlineCount,
          failedCount: result.failedCount,
          omittedCount: result.omittedCount,
          totalBytes: result.totalBytes,
          archiveParts: result.archiveParts,
          manifestSha256: result.manifestSha256,
          // A PST export discloses a RECONSTRUCTION, not natives. The audit log
          // is the record of what was disclosed, so it has to say which — a row
          // that reads like a native export of the same items would be wrong
          // about the one fact that matters later.
          ...(exportRow.kind === 'pst'
            ? { reconstruction: true, pstBytesAreHashVerifiable: false }
            : {}),
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

/** One archive part and the digest of the part itself, not of its contents. */
export interface ExportPartDigest {
  partNumber: number;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

interface ExportResult {
  itemCount: number;
  /** Attachments left inside a parent native rather than written as files. */
  inlineCount: number;
  failedCount: number;
  /**
   * Selected items a PST cannot hold (non-emails whose parent email is not
   * in this export). Named in exceptions.csv. Zero for csv/native.
   */
  omittedCount: number;
  totalBytes: number;
  outputPrefix: string;
  manifestSha256: string;
  archiveParts: number;
  /** One row per downloadable object. CSV is a single `export.csv` part. */
  parts: ExportPartDigest[];
}

/** Why a selected non-email is named in a PST export's exceptions.csv. */
export const PST_NOT_EMAIL_EXCEPTION =
  'not an email; a PST is a mailbox file and cannot hold this item';

/**
 * Split a PST selection into mail, attachments that already live inside that
 * mail, and everything else.
 *
 * A PST can only hold messages. An attachment of an email that IS going into
 * the PST is already inside that message, so listing it as "left out" would
 * be a lie. A loose PDF or Drive file has nowhere to go and must be named.
 *
 * Exported so a test can cover the split without running the PST writer.
 * The parent email may arrive in a later batch than the attachment, so the
 * caller must pass the whole selection, not one page.
 */
export function partitionPstSelection(
  items: readonly {
    id: string;
    kind: string;
    childRelationships: readonly { parentId: string; kind: string }[];
  }[],
): {
  emailIds: string[];
  omitted: { evidenceItemId: string; error: string }[];
  inlineCount: number;
} {
  const emailIds = items.filter((item) => item.kind === 'email').map((item) => item.id);
  const inPst = new Set(emailIds);
  const omitted: { evidenceItemId: string; error: string }[] = [];
  let inlineCount = 0;
  for (const item of items) {
    if (item.kind === 'email') continue;
    const rel = item.childRelationships.find((r) => isAttachmentKind(r.kind));
    if (rel !== undefined && inPst.has(rel.parentId)) {
      inlineCount += 1;
      continue;
    }
    omitted.push({ evidenceItemId: item.id, error: PST_NOT_EMAIL_EXCEPTION });
  }
  return { emailIds, omitted, inlineCount };
}

/**
 * `pst` export: hand the mail to the vendored PST writer, and only the mail.
 *
 * A PST is a mailbox file. A loose PDF has nowhere to go in one, so anything
 * that is not an email is skipped and named in the export's exceptions, rather
 * than silently dropped or wedged in as an orphan message. Selecting a mixed set
 * and asking for a PST is a real thing a user will do, and the export has to say
 * what it did with the rest.
 *
 * The interesting behaviour lives in `pst-export.ts`, including the rule that a
 * PST cannot ship without the native `.eml` digests beside it.
 */
async function runPstExportKind(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  exportName: string,
  params: ExportParameters,
  batches: AsyncIterable<LoadedExportItem[]>,
): Promise<ExportResult> {
  const items: PstExportItem[] = [];
  const malwareOmitted: { evidenceItemId: string; error: string }[] = [];
  const loaded: {
    id: string;
    kind: string;
    childRelationships: { parentId: string; kind: string }[];
  }[] = [];
  for await (const batch of batches) {
    for (const item of batch) {
      loaded.push({
        id: item.id,
        kind: item.kind,
        childRelationships: item.childRelationships,
      });
      if (item.kind !== 'email') continue;
      if (item.malwareStatus === 'infected' || item.blob?.storageClass === 'quarantine') {
        malwareOmitted.push({
          evidenceItemId: item.id,
          error: INFECTED_NATIVE_EXPORT_ERROR,
        });
        continue;
      }
      items.push({
        evidenceItemId: item.id,
        sha256: item.sha256,
        size: Number(item.size),
        subject: item.emailMetadata?.subject ?? item.name,
        // The real corpus has opaque Graph folder ids and messages with no
        // folder at all; `sourcePath` is what the collector recorded, and the
        // writer files anything blank under "Unfiled".
        folderPath: item.sourcePath,
        custodianEmail: item.custodian?.email ?? '',
        collectionId: item.collectionId ?? '',
        storageClass: item.blob?.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
        objectKey: item.blob?.objectKey ?? '',
        receivedAt:
          item.emailMetadata?.receivedAt?.toISOString() ??
          item.emailMetadata?.sentAt?.toISOString() ??
          item.primaryDate?.toISOString() ??
          null,
      });
    }
  }

  const split = partitionPstSelection(loaded);
  if (items.length === 0) {
    if (malwareOmitted.length > 0) {
      throw new Error(
        `every selected email is flagged as malware; native export is locked ` +
          `(${String(malwareOmitted.length)} item(s))`,
      );
    }
    throw new Error(
      split.omitted.length > 0
        ? `this selection has no email items, so there is nothing to put in a PST ` +
            `(${String(split.omitted.length)} non-email item(s) were selected)`
        : 'this selection is empty, so there is nothing to put in a PST',
    );
  }
  if (split.omitted.length > 0) {
    ctx.log.warn(
      { exportId, skipped: split.omitted.length },
      'pst export: non-email items cannot go in a mailbox file; they are listed as exceptions',
    );
  }

  const outcome = await runPstExport(ctx, tenantId, exportId, items, {
    binPath: ctx.config.CDFIR_PSTB_BIN,
    scratchRoot: ctx.config.CDFIR_EXPORT_SCRATCH_DIR,
    timeoutMs: ctx.config.CDFIR_PSTB_TIMEOUT_MS,
    spoolThresholdBytes: ctx.config.CDFIR_PSTB_SPOOL_THRESHOLD_BYTES,
    partBytes: params.pstPartMb * 1024 * 1024,
    storeDisplayName: pstStoreDisplayName(exportName),
    extraExceptions: [...split.omitted, ...malwareOmitted],
  });

  return {
    itemCount: outcome.itemCount,
    // Attachments of emails in this PST already live inside those messages.
    // Counted so the status line can say they were not dropped.
    inlineCount: split.inlineCount,
    failedCount: outcome.failedCount,
    omittedCount: split.omitted.length,
    totalBytes: outcome.totalBytes,
    outputPrefix: outcome.outputPrefix,
    manifestSha256: outcome.manifestSha256,
    archiveParts: outcome.parts.length,
    parts: outcome.parts,
  };
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
  const filename = archivePartFilename('csv', 1);
  const put = await ctx.store.putDerivative(
    tenantId,
    exportId,
    derivativeTypeFor('csv'),
    1,
    filename,
    csv,
    'text/csv; charset=utf-8',
  );
  // Sidecar next to the CSV, same as zip/PST: download always fetches
  // manifest.json, and hashes.txt names it. Using the CSV's own digest as the
  // "manifest" hash made verification look at a file that was never written.
  const manifestJson = canonicalJson({
    schema: 'cdfir.export.csv.manifest.v1',
    exportId,
    generatedAt: new Date().toISOString(),
    kind: 'csv',
    itemCount,
    filename,
    sha256: put.sha256,
    sizeBytes: put.size,
    items: [{ archivePart: 1, filename, sha256: put.sha256, sizeBytes: put.size }],
  });
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
    itemCount,
    // A CSV export has one row per item regardless of where the bytes live.
    inlineCount: 0,
    failedCount: 0,
    omittedCount: 0,
    totalBytes: csv.byteLength,
    outputPrefix: put.objectKey,
    manifestSha256: manifestPut.sha256,
    archiveParts: 1,
    parts: [
      {
        partNumber: 1,
        objectKey: put.objectKey,
        sha256: put.sha256,
        sizeBytes: put.size,
      },
    ],
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
 *
 * `itemCount` here is DELIVERED items (written files + inline attachments),
 * not selected items. So "everything failed verification" also lands as
 * itemCount 0 — and must NOT reuse the "selection was empty" sentence. That
 * wording sent operators to re-pick the tag while exceptions.csv held the
 * real answer (missing objects, hash mismatches, no preserved natives).
 *
 * `inlineCount` exists for the same reason as the empty warning. With
 * attachments left inside their parent emails, a 434,878-item export unzips
 * to 185,091 files. A reviewer who counts them and is told nothing has every
 * reason to think evidence went missing, so the difference is stated up front
 * rather than left to be found.
 */
export function exportStatusDetail(
  itemCount: number,
  failedCount: number,
  inlineCount = 0,
): string {
  if (itemCount === 0 && failedCount === 0) {
    return 'No items matched this selection, so the export is empty. Check that the tag, case or search you chose still contains items.';
  }
  if (itemCount === 0 && failedCount > 0) {
    return (
      `${String(failedCount)} item(s) failed verification; nothing was written into the archive. ` +
      'Open the export and read exceptions.csv — the selection matched items, but every one failed hash or storage checks.'
    );
  }
  const said: string[] = [];
  if (inlineCount > 0) {
    const n = (v: number): string => v.toLocaleString('en-US');
    said.push(
      `${n(itemCount)} items: ${n(itemCount - inlineCount)} file(s) in the archive, plus ` +
        `${n(inlineCount)} attachment(s) left inside the parent emails that already contain them. ` +
        `Every one is listed in manifest.json; inline-attachments.csv names the file each is in.`,
    );
  }
  if (failedCount > 0) said.push(`${String(failedCount)} item(s) failed verification`);
  return said.join(' ');
}

/**
 * What the operator is told about a finished PST export.
 *
 * The zip status line talks about files in an archive and inline-attachments.csv.
 * A PST has neither. Reusing it would tell a reviewer to open a file that does
 * not exist, and would call omitted PDFs "failed verification".
 */
export function pstExportStatusDetail(
  itemCount: number,
  failedCount: number,
  attachmentsInMessages = 0,
  omittedCount = 0,
): string {
  if (itemCount === 0) {
    return 'No items matched this selection, so the export is empty. Check that the tag, case or search you chose still contains items.';
  }
  const n = (v: number): string => v.toLocaleString('en-US');
  const said: string[] = [];
  if (attachmentsInMessages > 0) {
    said.push(
      `${n(itemCount)} email(s) in the PST, plus ${n(attachmentsInMessages)} attachment(s) already inside those messages.`,
    );
  }
  if (omittedCount > 0) {
    said.push(
      `${n(omittedCount)} non-email item(s) were left out of the PST and listed in exceptions.csv`,
    );
  }
  if (failedCount > 0) said.push(`${String(failedCount)} item(s) failed verification`);
  return said.join(' ');
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
  const inline = params.attachments === 'inline';
  const manifestEntries: ManifestEntry[] = [];
  // Seeded with the parent paths decided up front, so nothing else can be
  // named onto one of them before its parent is reached.
  const usedPaths = new Set<string>(family.pathById.values());

  /** Claim a path for an item that gets its own entry in the zip. */
  const allocatePath = (item: LoadedExportItem): string => {
    const dir = custodianDir(item.custodian?.email);
    let familyDir = '';
    // Family directories exist only to hold extracted attachments. With
    // attachments left inline there is nothing to put in them, so they go.
    if (!inline) {
      const rel = item.childRelationships.find((r) => isAttachmentKind(r.kind));
      if (rel !== undefined) {
        const parentName = family.nameById.get(rel.parentId) ?? 'family';
        familyDir = `${sanitizeFilename(parentName)}-${rel.parentId.slice(0, 8)}`;
      } else if (family.parents.has(item.id)) {
        familyDir = `${sanitizeFilename(item.name)}-${item.id.slice(0, 8)}`;
      }
    }
    let candidate = ['custodian', dir, familyDir, archiveFileName(item)]
      .filter((p) => p !== '')
      .join('/');
    if (usedPaths.has(candidate)) candidate = withIdSuffix(candidate, item.id);
    usedPaths.add(candidate);
    return candidate;
  };

  type Placement =
    | { mode: 'file'; path: string; note: string }
    | { mode: 'inline'; containerId: string; containerPath: string };

  /**
   * Whether this item needs its own entry in the zip, and where.
   *
   * The whole change lives here. An attachment whose parent email IS in this
   * export needs no entry: those exact bytes are already in the archive,
   * inside the `.eml`.
   */
  const placementFor = (item: LoadedExportItem): Placement => {
    if (inline) {
      const rel = item.childRelationships.find((r) => isAttachmentKind(r.kind));
      if (rel !== undefined) {
        const containerPath = family.pathById.get(rel.parentId);
        if (containerPath !== undefined) {
          return { mode: 'inline', containerId: rel.parentId, containerPath };
        }
        // The case that loses evidence if you get it wrong: someone tags ONE
        // attachment and exports just that. Its parent is not in the
        // selection, so there is no `.eml` here for it to be inside. It is
        // written as its own file, and the manifest says why.
        return {
          mode: 'file',
          path: allocatePath(item),
          note: 'parent native is not in this export, so this attachment was written as its own file',
        };
      }
      // A parent's own path was decided up front so its attachments could
      // record it. Reuse it rather than allocating a second one.
      const known = family.pathById.get(item.id);
      if (known !== undefined) return { mode: 'file', path: known, note: '' };
    }
    return { mode: 'file', path: allocatePath(item), note: '' };
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
  /**
   * The digest of each archive part, which `putDerivative` has always returned
   * and this function used to throw away.
   *
   * The manifest hashes every ITEM, which proves the contents once they are
   * extracted. It says nothing about whether a 2 GiB part arrived intact, and
   * a 130 GiB export is 65 of them. Without this, the only way to spot a
   * truncated part was to unzip everything and hash 434,878 items.
   */
  const parts: ExportPartDigest[] = [];

  const rotatePart = async (): Promise<void> => {
    await writer.finalize();
    const done = await upload;
    outputPrefix = outputPrefix === '' ? done.objectKey : outputPrefix;
    // Recorded BEFORE the increment: `done` is the part just finalised.
    parts.push({
      partNumber,
      objectKey: done.objectKey,
      sha256: done.sha256,
      sizeBytes: done.size,
    });
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

  /**
   * Stream one item's native bytes into the archive and hash them on the way.
   *
   * Mutates `entry` and returns what happened. Pulled out of the loop so the
   * rescue pass below can write an item the same way the main pass does —
   * two copies of this would be two chances to disagree about verification.
   */
  const writeNative = async (
    item: LoadedExportItem,
    entry: ManifestEntry,
  ): Promise<'verified' | 'failed'> => {
    const size = Number(item.size);
    if (item.blob === null || item.sha256 === '') {
      entry.error = 'no preserved native bytes';
      return 'failed';
    }
    if (item.malwareStatus === 'infected' || item.blob.storageClass === 'quarantine') {
      entry.error = INFECTED_NATIVE_EXPORT_ERROR;
      return 'failed';
    }
    if (shouldStartNewArchive(bytesInPart, size, splitBytes)) {
      await rotatePart();
    }
    entry.archivePart = partNumber;
    try {
      const source = await ctx.store.getStream(
        item.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
        item.blob.objectKey,
      );
      const hasher = new Sha256Stream();
      const pass = new PassThrough();
      writer.append(entry.archivePath, pass);
      await pipeline(source, hasher, pass);
      const actual = hasher.digestHex();
      if (actual !== item.sha256) {
        // The bytes are already in the archive; record the mismatch honestly
        // and continue — the manifest and ExportItem mark it failed.
        entry.error = `sha256 mismatch: expected ${item.sha256}, streamed ${actual}`;
        return 'failed';
      }
      entry.verified = true;
      bytesInPart += size;
      totalBytes += size;
      return 'verified';
    } catch (err) {
      entry.error = sanitizeError(err);
      return 'failed';
    }
  };

  let inlineCount = 0;
  /** Container id -> the manifest rows filed as being inside it. */
  const inlinedByParent = new Map<string, { itemId: string; entryIndex: number }[]>();
  /** Container id -> the part it actually landed in. Absent means not written. */
  const partByParentId = new Map<string, number>();

  let seen = 0;
  for await (const batch of batches) {
    for (const item of batch) {
      seen += 1;
      const placement = placementFor(item);
      const entry: ManifestEntry = {
        evidenceItemId: item.id,
        placement: placement.mode,
        archivePath: placement.mode === 'file' ? placement.path : '',
        containerPath: placement.mode === 'inline' ? placement.containerPath : '',
        containerItemId: placement.mode === 'inline' ? placement.containerId : '',
        // Patched to the container's real part once that part is known.
        archivePart: placement.mode === 'file' ? partNumber : 0,
        sha256: item.sha256,
        size: Number(item.size),
        custodianEmail: item.custodian?.email ?? '',
        custodianId: item.custodianId ?? '',
        collectionId: item.collectionId ?? '',
        verified: false,
        note: placement.mode === 'file' ? placement.note : '',
        error: '',
      };

      if (placement.mode === 'inline') {
        // Nothing is written and nothing is hashed: these exact bytes are
        // already in the archive inside the parent. The row still goes in the
        // manifest, because an item that quietly vanished from the manifest is
        // indistinguishable from evidence that was never collected.
        //
        // `verified` stays false on purpose. We did not hash these bytes
        // independently, and saying we did would be the lie this product
        // exists to avoid.
        inlineCount += 1;
        const filed = inlinedByParent.get(placement.containerId) ?? [];
        filed.push({ itemId: item.id, entryIndex: manifestEntries.length });
        inlinedByParent.set(placement.containerId, filed);
        manifestEntries.push(entry);
        await upsertExportItem(ctx, tenantId, exportId, item.id, entry, 'written');
        continue;
      }

      const state = await writeNative(item, entry);
      if (state === 'verified') {
        written += 1;
        if (family.parents.has(item.id)) partByParentId.set(item.id, entry.archivePart);
      } else {
        failedCount += 1;
      }
      manifestEntries.push(entry);
      await upsertExportItem(ctx, tenantId, exportId, item.id, entry, state);
    }
  }

  /**
   * Rescue: a parent that failed to write is not in the archive, so anything
   * filed as "inside it" is nowhere at all.
   *
   * The parent being in the SELECTION is not the same as the parent being in
   * the ARCHIVE. A parent with no preserved native bytes, or one whose bytes
   * no longer hash to their recorded digest, is recorded as failed and never
   * written — and without this pass its attachments would be dropped silently,
   * which is the exact failure this change must not introduce. Normally empty.
   */
  const orphaned = [...inlinedByParent.entries()].filter(([id]) => !partByParentId.has(id));
  if (orphaned.length > 0) {
    const byItemId = new Map(orphaned.flatMap(([, kids]) => kids.map((k) => [k.itemId, k])));
    ctx.log.warn(
      { exportId, parents: orphaned.length, attachments: byItemId.size },
      'export: parent natives missing from the archive; writing their attachments as files',
    );
    for await (const batch of loadItemsInBatches(ctx, tenantId, [...byItemId.keys()])) {
      for (const item of batch) {
        const filed = byItemId.get(item.id);
        const entry = filed === undefined ? undefined : manifestEntries[filed.entryIndex];
        if (entry === undefined) continue;
        entry.placement = 'file';
        entry.archivePath = allocatePath(item);
        entry.containerPath = '';
        entry.containerItemId = '';
        entry.note =
          'the parent native could not be exported, so this attachment was written as its own file rather than lost';
        inlineCount -= 1;
        const state = await writeNative(item, entry);
        if (state === 'verified') written += 1;
        else failedCount += 1;
        await upsertExportItem(ctx, tenantId, exportId, item.id, entry, state);
      }
    }
  }

  // An inline row's part is its container's part, which is only known once the
  // container has been written. Every remaining inline row has one, because
  // the rescue pass above converted the ones that did not.
  for (const [parentId, filed] of inlinedByParent) {
    const part = partByParentId.get(parentId);
    if (part === undefined) continue;
    for (const { entryIndex } of filed) {
      const entry = manifestEntries[entryIndex];
      if (entry?.placement === 'inline') entry.archivePart = part;
    }
  }

  // Manifests and reports live in the FINAL archive part.
  const manifestJson = canonicalJson({
    // v2 adds `placement`, `containerPath`, `containerItemId` and `note` to
    // every entry, because with attachments left inline an entry can describe
    // an item that is in the archive without being a file of its own.
    schema: 'cdfir.export.manifest.v2',
    exportId,
    generatedAt: new Date().toISOString(),
    attachments: params.attachments,
    itemCount: seen,
    /** Items written as their own file AND hashed on the way in. */
    verifiedCount: written,
    /** Items whose bytes are in the archive inside a parent native. */
    inlineAttachmentCount: inlineCount,
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
      // Appended, so a reader that only knows the old columns still parses.
      'placement',
      'containerPath',
      'note',
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
        e.placement,
        e.containerPath,
        e.note,
      ]
        .map((v) => csvEscape(v))
        .join(','),
    ),
  ];
  // Only files that exist, so `sha256sum -c hashlist.txt` runs clean. Inline
  // attachments are NOT commented in here: GNU coreutils answers a comment
  // line with "WARNING: N lines are improperly formatted", and a warning in
  // the middle of an evidence check is worse than a second file. They get
  // inline-attachments.csv instead, and the README points at it.
  const hashlist = manifestEntries
    .filter((e) => e.verified && e.placement === 'file')
    .map((e) => `${e.sha256}  ${e.archivePath}`)
    .join('\n');
  const exceptionsCsv = [
    ['evidenceItemId', 'archivePath', 'error'].map((c) => csvEscape(c)).join(','),
    ...manifestEntries
      // `placement === 'file'` matters: an inline attachment is unverified
      // because it was never hashed separately, not because anything failed.
      // Listing a quarter of a million of them as exceptions would bury the
      // handful that really did fail.
      .filter((e) => !e.verified && e.placement === 'file')
      .map((e) => [e.evidenceItemId, e.archivePath, e.error].map((v) => csvEscape(v)).join(',')),
  ];
  const inlineEntries = manifestEntries.filter((e) => e.placement === 'inline');
  const inlineCsv = [
    ['evidenceItemId', 'sha256', 'size', 'containerItemId', 'containerPath', 'part']
      .map((c) => csvEscape(c))
      .join(','),
    ...inlineEntries.map((e) =>
      [
        e.evidenceItemId,
        e.sha256,
        String(e.size),
        e.containerItemId,
        e.containerPath,
        String(e.archivePart),
      ]
        .map((v) => csvEscape(v))
        .join(','),
    ),
  ];
  const readme = [
    'AEG-CloudDFIR native export',
    '===========================',
    '',
    `Attachment layout: ${params.attachments}`,
    '',
    ...(inlineCount > 0
      ? [
          'Why there are fewer files than items',
          '------------------------------------',
          `This export covers ${String(seen)} item(s) and unzips to ${String(written)} file(s).`,
          `The other ${String(inlineCount)} are email attachments, and they are NOT missing:`,
          'an .eml file is RFC822 and already carries its attachments inside it, so',
          'writing them out again would put a second copy of the same bytes in this',
          'archive. They are listed in manifest.json with placement "inline" and in',
          'inline-attachments.csv, which names the .eml each one is inside.',
          '',
          'To check one of them:',
          '  1. Open the .eml named in the containerPath column with any mail client,',
          '     or run `munpack`, `ripmime`, or a few lines of Python:',
          "       python3 -c \"import email,sys;[open(p.get_filename() or 'part','wb')" +
            '.write(p.get_payload(decode=True)) for p in email.message_from_file(' +
            'open(sys.argv[1])).walk() if p.get_filename()]" <file.eml>',
          '  2. SHA-256 the extracted attachment and compare with the sha256 column.',
          '',
          'An attachment whose parent email is NOT in this export is written as its',
          'own file instead, with the reason in the "note" column. Nothing is dropped.',
          '',
        ]
      : []),
    'Verification:',
    '  1. Extract every archive part.',
    '  2. Run `sha256sum -c hashlist.txt` (or `shasum -a 256 -c hashlist.txt`).',
    '     It lists every file in this archive and nothing else, so it should',
    '     report OK for all of them and complain about none.',
    '  3. manifest.json is canonical JSON; recompute its SHA-256 and compare',
    '     with the value recorded on the export record.',
    '  4. exceptions.csv lists any item that failed hash verification.',
    ...(inlineCount > 0
      ? ['  5. inline-attachments.csv lists every attachment left inside its parent.']
      : []),
    '',
    TRUTHFULNESS_NOTICES.defensibility,
  ].join('\n');

  writer.append('manifest.json', Buffer.from(manifestJson, 'utf8'));
  writer.append('manifest.csv', Buffer.from(manifestCsvLines.join('\r\n') + '\r\n', 'utf8'));
  writer.append('hashlist.txt', Buffer.from(hashlist + '\n', 'utf8'));
  writer.append('exceptions.csv', Buffer.from(exceptionsCsv.join('\r\n') + '\r\n', 'utf8'));
  if (inlineEntries.length > 0) {
    writer.append('inline-attachments.csv', Buffer.from(inlineCsv.join('\r\n') + '\r\n', 'utf8'));
  }
  writer.append('README.txt', Buffer.from(readme, 'utf8'));
  await writer.finalize();
  const lastUpload = await upload;
  outputPrefix = outputPrefix === '' ? lastUpload.objectKey : outputPrefix;
  // The final part never goes through rotatePart, so it is recorded here or
  // not at all. A single-part export reaches this line having pushed nothing.
  parts.push({
    partNumber,
    objectKey: lastUpload.objectKey,
    sha256: lastUpload.sha256,
    sizeBytes: lastUpload.size,
  });

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
    // Files written PLUS attachments carried inside them. Both are in the
    // archive, so both count as delivered — reporting only the file count
    // would tell a reviewer that 249,787 items went missing.
    itemCount: written + inlineCount,
    inlineCount,
    failedCount,
    omittedCount: 0,
    totalBytes,
    outputPrefix,
    manifestSha256: manifestPut.sha256,
    archiveParts: partNumber,
    parts,
  };
}

async function upsertExportItem(
  ctx: WorkerContext,
  tenantId: string,
  exportId: string,
  evidenceItemId: string,
  entry: ManifestEntry,
  /**
   * `written` is the inline case: the bytes ARE in the archive, inside a
   * parent native, but we did not hash them separately so they are not
   * `verified`. The enum already had the word for that.
   */
  state: 'verified' | 'written' | 'failed',
): Promise<void> {
  // For an inline attachment there is no file to point at, so the column
  // records the file it is inside. The `inside:` prefix is there so nobody
  // ever reads this as a path they can extract. Nothing parses this column;
  // manifest.json is the artifact a reviewer works from.
  const archivePath =
    entry.placement === 'inline' ? `inside:${entry.containerPath}` : entry.archivePath;
  await withTenantContext(ctx.prisma, tenantId, (tx) =>
    tx.exportItem.upsert({
      where: { exportId_evidenceItemId: { exportId, evidenceItemId } },
      create: {
        tenantId,
        exportId,
        evidenceItemId,
        archivePath,
        sha256: entry.sha256,
        verified: entry.verified,
        state,
        error: entry.error,
      },
      update: {
        archivePath,
        sha256: entry.sha256,
        verified: entry.verified,
        state,
        error: entry.error,
      },
    }),
  );
}
