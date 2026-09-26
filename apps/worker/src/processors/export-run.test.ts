import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE, EXPORT_ID, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import {
  buildFamilyIndex,
  expandFamilies,
  exportStatusDetail,
  keepImportReadableIds,
  loadItemsInBatches,
  partitionPstSelection,
  processExportRun,
  PST_NOT_EMAIL_EXCEPTION,
  pstExportStatusDetail,
  shouldStartNewArchive,
  type ArchiveWriterLike,
} from './export-run.js';

const GOOD_ID = EVIDENCE;
const BAD_ID = '99999999-9999-4999-8999-999999999999';
const GOOD_CONTENT = Buffer.from('hello export');
const GOOD_SHA = createHash('sha256').update(GOOD_CONTENT).digest('hex');

const payload = { tenantId: TENANT, exportId: EXPORT_ID };

function evidenceRow(id: string, sha256: string): Record<string, unknown> {
  return {
    id,
    kind: 'file',
    name: `${id.slice(0, 4)}.txt`,
    extension: 'txt',
    mimeType: 'text/plain',
    size: BigInt(GOOD_CONTENT.byteLength),
    sha256,
    custodianId: null,
    collectionId: null,
    sourcePath: '/x',
    sourceLabels: [],
    processingStatus: 'extracted',
    malwareStatus: 'clean',
    isApiExportDerivative: false,
    primaryDate: null,
    acquiredAt: new Date('2026-01-01T00:00:00Z'),
    blob: {
      objectKey: `tenants/${TENANT}/originals/sha256/aa/${sha256}`,
      storageClass: 'original',
    },
    custodian: { email: 'user@example.com' },
    emailMetadata: null,
    participants: [],
    tagAssignments: [],
    childRelationships: [],
  };
}

function arm(f: FakeCtx): { writer: ArchiveWriterLike; append: ReturnType<typeof vi.fn> } {
  f.tx.export.findUnique.mockResolvedValue({
    id: EXPORT_ID,
    kind: 'native',
    status: 'queued',
    parameters: {
      selection: { kind: 'items', evidenceItemIds: [GOOD_ID, BAD_ID] },
      includeFamilies: false,
      archiveSplitMb: 2048,
    },
  });
  f.tx.evidenceItem.findMany.mockResolvedValue([
    evidenceRow(GOOD_ID, GOOD_SHA),
    evidenceRow(BAD_ID, 'f'.repeat(64)), // recorded hash will NOT match the bytes
  ]);
  f.store.getStream.mockImplementation(() => Promise.resolve(Readable.from(GOOD_CONTENT)));
  const append = vi.fn();
  const writer: ArchiveWriterLike = {
    append,
    finalize: vi.fn().mockResolvedValue({ entryCount: 2 }),
  };
  return { writer, append };
}

describe('shouldStartNewArchive', () => {
  it('splits only when the current part is non-empty and would overflow', () => {
    const split = 100;
    expect(shouldStartNewArchive(0, 500, split)).toBe(false); // oversized item, own part
    expect(shouldStartNewArchive(60, 30, split)).toBe(false);
    expect(shouldStartNewArchive(60, 50, split)).toBe(true);
    expect(shouldStartNewArchive(100, 1, split)).toBe(true);
  });
});

describe('processExportRun (native)', () => {
  it('marks a hash-mismatched item failed but completes the export as ready', async () => {
    const f = fakeCtx();
    const { writer } = arm(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writer });

    const upserts = f.tx.exportItem.upsert.mock.calls.map(
      (c) =>
        c[0] as {
          where: { exportId_evidenceItemId: { evidenceItemId: string } };
          create: Record<string, unknown>;
        },
    );
    const good = upserts.find((u) => u.where.exportId_evidenceItemId.evidenceItemId === GOOD_ID);
    const bad = upserts.find((u) => u.where.exportId_evidenceItemId.evidenceItemId === BAD_ID);
    expect(good?.create['state']).toBe('verified');
    expect(good?.create['verified']).toBe(true);
    expect(bad?.create['state']).toBe('failed');
    expect(String(bad?.create['error'])).toContain('sha256 mismatch');

    const finalUpdate = f.tx.export.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('ready');
    expect(finalUpdate.data['itemCount']).toBe(1);
    expect(String(finalUpdate.data['statusDetail'])).toContain('1 item(s) failed verification');

    const audit = f.tx.auditEvent.create.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data['action']).toBe('export.completed');
  });
});

describe('keepImportReadableIds', () => {
  const BOB = '22222222-2222-4222-8222-222222222222';
  const BOB_MEMBERSHIP = '33333333-3333-4333-8333-333333333333';

  it("drops another user's unattached forensic import from a tag export", async () => {
    const f = fakeCtx();
    f.tx.membership.findFirst.mockResolvedValue({
      id: BOB_MEMBERSHIP,
      roles: [{ role: 'case_manager' }],
    });
    f.tx.evidenceItem.findMany.mockResolvedValue([{ id: GOOD_ID }]);

    const kept = await keepImportReadableIds(f.ctx, TENANT, BOB, [GOOD_ID, BAD_ID]);
    expect(kept).toEqual([GOOD_ID]);
    expect(f.tx.evidenceItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { importId: null },
            { forensicImport: { is: { createdById: BOB } } },
          ]),
        }),
      }),
    );
  });

  it('does not fence an org_admin exporter', async () => {
    const f = fakeCtx();
    f.tx.membership.findFirst.mockResolvedValue({
      id: BOB_MEMBERSHIP,
      roles: [{ role: 'org_admin' }],
    });
    const kept = await keepImportReadableIds(f.ctx, TENANT, BOB, [GOOD_ID, BAD_ID]);
    expect(kept).toEqual([GOOD_ID, BAD_ID]);
    expect(f.tx.evidenceItem.findMany).not.toHaveBeenCalled();
  });
});

describe('processExportRun (native) extras', () => {
  it('appends manifests, hashlist, exceptions, and README to the archive', async () => {
    const f = fakeCtx();
    const { writer, append } = arm(f);
    await processExportRun(f.ctx, payload, { createArchive: () => writer });
    const paths = append.mock.calls.map((c) => c[0] as string);
    for (const expected of [
      'manifest.json',
      'manifest.csv',
      'hashlist.txt',
      'exceptions.csv',
      'README.txt',
    ]) {
      expect(paths).toContain(expected);
    }
    // Item entries are grouped under custodian directories.
    expect(paths.some((p) => p.startsWith('custodian/user@example.com/'))).toBe(true);
  });

  it('fails the export record on systemic errors instead of throwing', async () => {
    const f = fakeCtx();
    arm(f);
    f.tx.export.findUnique.mockResolvedValue({
      id: EXPORT_ID,
      kind: 'native',
      status: 'queued',
      parameters: { selection: { kind: 'nonsense' } },
    });
    await expect(processExportRun(f.ctx, payload)).resolves.toBeUndefined();
    const finalUpdate = f.tx.export.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data['status']).toBe('failed');
  });

  it('returns without work for already-finished exports', async () => {
    const f = fakeCtx();
    f.tx.export.findUnique.mockResolvedValue({
      id: EXPORT_ID,
      kind: 'native',
      status: 'ready',
      parameters: {},
    });
    await processExportRun(f.ctx, payload);
    expect(f.tx.export.update).not.toHaveBeenCalled();
  });
});

describe('exportStatusDetail', () => {
  it('says plainly when an export produced nothing', () => {
    // A real run: a tag with no items assigned finished as status "ready",
    // itemCount 0, statusDetail empty — indistinguishable from a good export
    // unless you noticed the zero.
    const detail = exportStatusDetail(0, 0);
    expect(detail).toContain('No items matched');
    expect(detail).toContain('empty');
    // And it points at the cause rather than just stating the fact.
    expect(detail).toMatch(/tag, case or search/);
  });

  it('still reports verification failures on a non-empty export', () => {
    expect(exportStatusDetail(10, 3)).toBe('3 item(s) failed verification');
  });

  it('says nothing when everything worked', () => {
    expect(exportStatusDetail(10, 0)).toBe('');
  });

  it('prefers the empty message when there is nothing AND nothing failed', () => {
    // failedCount 0 with itemCount 0 is the exact shape the real bug had.
    expect(exportStatusDetail(0, 0)).not.toBe('');
  });

  it('does not call a total verification failure an empty selection', () => {
    // itemCount is delivered items (written + inline). When every selected
    // item fails hash or storage checks, delivered is 0 and failedCount is N.
    // The old branch treated that like "tag had no items" and pointed operators
    // at the wrong cause while exceptions.csv held the integrity failures.
    const detail = exportStatusDetail(0, 32);
    expect(detail).toContain('32 item(s) failed verification');
    expect(detail).toMatch(/exceptions\.csv/);
    expect(detail).not.toContain('No items matched');
    expect(detail).not.toMatch(/tag, case or search/);
  });

  it('explains the difference between items and files when attachments are inline', () => {
    // The real shape: winder 3, 434,878 items, 185,091 files on disk. A
    // reviewer who counts the files and is told nothing has every reason to
    // think a quarter of a million items went missing.
    const detail = exportStatusDetail(434_878, 0, 249_787);
    expect(detail).toContain('434,878 items');
    expect(detail).toContain('185,091 file(s)');
    expect(detail).toContain('249,787 attachment(s)');
    expect(detail).toContain('inline-attachments.csv');
  });

  it('still reports failures alongside the inline explanation', () => {
    const detail = exportStatusDetail(100, 3, 40);
    expect(detail).toContain('60 file(s)');
    expect(detail).toContain('3 item(s) failed verification');
  });
});

describe('native export status when every item fails verification', () => {
  it('says verification failed, not that the selection was empty', async () => {
    // Same shape as the path-naming arm: every item has blob: null, so each
    // lands in exceptions.csv and delivered itemCount is 0. Ready + the empty
    // selection sentence would have told an operator to re-pick the tag.
    const f = fakeCtx();
    armGenerated(f, 5);
    await processExportRun(f.ctx, payload, { createArchive: () => silentWriter() });

    const final = f.tx.export.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(final.data['status']).toBe('ready');
    expect(final.data['itemCount']).toBe(0);
    const detail = String(final.data['statusDetail']);
    expect(detail).toContain('5 item(s) failed verification');
    expect(detail).not.toContain('No items matched');
  });
});

describe('partitionPstSelection', () => {
  const email = {
    id: 'mail-1',
    kind: 'email',
    childRelationships: [] as { parentId: string; kind: string }[],
  };
  const attachedPdf = {
    id: 'att-1',
    kind: 'file',
    childRelationships: [{ parentId: 'mail-1', kind: 'attachment' }],
  };
  const loosePdf = {
    id: 'file-1',
    kind: 'file',
    childRelationships: [] as { parentId: string; kind: string }[],
  };
  const orphanAttachment = {
    id: 'att-orphan',
    kind: 'file',
    childRelationships: [{ parentId: 'mail-missing', kind: 'attachment' }],
  };

  it('names a loose non-email in exceptions, not as a verification failure', () => {
    const split = partitionPstSelection([email, loosePdf]);
    expect(split.emailIds).toEqual(['mail-1']);
    expect(split.inlineCount).toBe(0);
    expect(split.omitted).toEqual([{ evidenceItemId: 'file-1', error: PST_NOT_EMAIL_EXCEPTION }]);
  });

  it('does not list an attachment whose parent email is in the PST', () => {
    // The bytes are already inside the message. Calling that "left out" would
    // be the same lie the zip path used to tell about inline attachments.
    const split = partitionPstSelection([attachedPdf, email]);
    expect(split.omitted).toEqual([]);
    expect(split.inlineCount).toBe(1);
  });

  it('lists an attachment whose parent email is not in this export', () => {
    const split = partitionPstSelection([orphanAttachment, email]);
    expect(split.omitted).toEqual([
      { evidenceItemId: 'att-orphan', error: PST_NOT_EMAIL_EXCEPTION },
    ]);
    expect(split.inlineCount).toBe(0);
  });

  it('treats a family-linked file as omitted, not as inside the message', () => {
    const related = {
      id: 'related-1',
      kind: 'file',
      childRelationships: [{ parentId: 'mail-1', kind: 'family' }],
    };
    const split = partitionPstSelection([email, related]);
    expect(split.inlineCount).toBe(0);
    expect(split.omitted).toEqual([
      { evidenceItemId: 'related-1', error: PST_NOT_EMAIL_EXCEPTION },
    ]);
  });
});

describe('pstExportStatusDetail', () => {
  it('does not call omitted items failed verification', () => {
    const detail = pstExportStatusDetail(10, 0, 0, 4);
    expect(detail).toContain('4 non-email item(s) were left out of the PST');
    expect(detail).toContain('exceptions.csv');
    expect(detail).not.toMatch(/failed verification/);
  });

  it('says attachments stayed inside the messages, without naming a zip file', () => {
    const detail = pstExportStatusDetail(10, 0, 40, 0);
    expect(detail).toContain('10 email(s) in the PST');
    expect(detail).toContain('40 attachment(s) already inside those messages');
    expect(detail).not.toContain('inline-attachments.csv');
  });

  it('still reports real hash failures', () => {
    expect(pstExportStatusDetail(10, 2, 0, 1)).toContain('2 item(s) failed verification');
  });
});

describe('expandFamilies opens a transaction per batch', () => {
  /**
   * The bug this guards against. Chunking alone fixed the bind-variable
   * ceiling and left the transaction timeout in place: the whole chunked loop
   * ran inside ONE interactive transaction, capped at 30 seconds. A 434,910-item
   * export is 174 round trips, giving each 172 ms, and it failed at 30,244 ms
   * with `Transaction already closed` before writing a byte.
   *
   * Counting $transaction calls is what tells the two apart — one call means the
   * old shape is back, however well the query itself is chunked.
   */
  it('uses one short transaction per batch, not one around the whole loop', async () => {
    const ctx = fakeCtx();
    let transactions = 0;
    const tx = {
      evidenceRelationship: { findMany: vi.fn().mockResolvedValue([]) },
      $executeRaw: vi.fn().mockResolvedValue(0),
    };
    (ctx as { prisma: unknown }).prisma = {
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        transactions += 1;
        return fn(tx);
      },
    };

    // 3 batches of relationships (chunk is QUERY_ID_CHUNK / 2 = 2,500).
    const ids = Array.from(
      { length: 6_000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await expandFamilies(ctx as unknown as FakeCtx, TENANT, ids);

    // 3 for the relationship batches; the sibling pass adds none because the
    // fake returns no relationships, so there are no parents to follow.
    expect(transactions).toBeGreaterThan(1);
    expect(tx.evidenceRelationship.findMany).toHaveBeenCalledTimes(3);
  });

  it('returns the input unchanged when there is nothing to expand', async () => {
    const ctx = fakeCtx();
    await expect(expandFamilies(ctx, TENANT, [])).resolves.toEqual([]);
  });
});

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Arm a native export over `count` generated items.
 *
 * Every item has `blob: null`, so each one is recorded as "no preserved native
 * bytes" and skipped before any streaming or hashing. That is deliberate: the
 * path-naming work under test happens BEFORE the blob check, so this exercises
 * it for every item without the cost of faking object storage.
 *
 * `childRelationships` is a counting getter. How many times the export reads
 * it is the whole point — see the test below.
 */
function armGenerated(
  f: FakeCtx,
  count: number,
  opts: { onRelRead?: () => void; onQuery?: () => void; relsFor?: (id: string) => unknown[] } = {},
): string[] {
  const ids = Array.from({ length: count }, (_, i) => uuid(i));
  f.tx.export.findUnique.mockResolvedValue({
    id: EXPORT_ID,
    kind: 'native',
    status: 'queued',
    parameters: {
      selection: { kind: 'items', evidenceItemIds: ids },
      includeFamilies: false,
      archiveSplitMb: 2048,
    },
  });
  f.tx.evidenceRelationship.findMany.mockResolvedValue([]);
  f.tx.evidenceItem.findMany.mockImplementation((args: Record<string, unknown>) => {
    // buildFamilyIndex asks for { id, name }; the import-ACL fence asks for
    // { id } only; the item stream asks with `include`.
    const select = args['select'] as { id?: boolean; name?: boolean } | undefined;
    if (select !== undefined) {
      if (select.id === true && select.name === undefined) {
        const where = args['where'] as { id: { in: string[] } };
        return Promise.resolve(where.id.in.map((id) => ({ id })));
      }
      return Promise.resolve([]);
    }
    opts.onQuery?.();
    const where = args['where'] as { id: { in: string[] } };
    return Promise.resolve(
      where.id.in.map((id) => {
        const row = { ...evidenceRow(id, GOOD_SHA), blob: null };
        Object.defineProperty(row, 'childRelationships', {
          enumerable: true,
          get: () => {
            opts.onRelRead?.();
            return opts.relsFor?.(id) ?? [];
          },
        });
        return row;
      }),
    );
  });
  return ids;
}

function silentWriter(): ArchiveWriterLike {
  return { append: vi.fn(), finalize: vi.fn().mockResolvedValue({ entryCount: 0 }) };
}

describe('native export does not scan the item list per item', () => {
  /**
   * The bug this guards against. `archivePathFor` asked "does anything here
   * call me its parent?" by scanning the WHOLE loaded list, once per item.
   * That is quadratic. At 434,910 items it is roughly 1.9e11 comparisons, so
   * the export stops making progress rather than failing outright — and it
   * only appeared at that size because the previous largest export was 43,379
   * items, a hundred times smaller and ten thousand times cheaper.
   *
   * Counting reads of `childRelationships` is what tells the two shapes apart.
   * Linear is one read per item (its own `.find()`); the old shape is one read
   * per item PER ITEM. A correctness assertion cannot see the difference, and
   * a timing assertion would be flaky, so this counts.
   */
  it('reads each item\u2019s relationships a constant number of times, not once per item', async () => {
    const f = fakeCtx();
    const count = 500;
    let relReads = 0;
    armGenerated(f, count, { onRelRead: () => (relReads += 1) });

    await processExportRun(f.ctx, payload, { createArchive: () => silentWriter() });

    // Lower bound first, or this passes for free if naming stops running at
    // all: every item must have its own relationships read.
    expect(relReads).toBeGreaterThanOrEqual(count);
    // Linear: one read per item. The old shape would be ~250,000 here.
    expect(relReads).toBeLessThanOrEqual(count * 2);
    expect(f.tx.exportItem.upsert).toHaveBeenCalledTimes(count);
  });
});

describe('native export streams items instead of holding them all', () => {
  /**
   * Every item used to be materialised before a byte was written — 434,910 of
   * them, each with seven nested includes, plus a Map holding every one again.
   *
   * Proving it streams means proving work happens BETWEEN batch queries. If
   * the loader still gathered everything first, every query would land before
   * the first item was processed.
   */
  it('processes items from the first batch before it fetches the last', async () => {
    const f = fakeCtx();
    const events: string[] = [];
    // QUERY_ID_CHUNK is 5,000, so this is two batches.
    const count = 6_000;
    armGenerated(f, count, { onQuery: () => events.push('query') });
    f.tx.exportItem.upsert.mockImplementation(() => {
      events.push('item');
      return Promise.resolve({});
    });

    await processExportRun(f.ctx, payload, { createArchive: () => silentWriter() });

    expect(events.filter((e) => e === 'query')).toHaveLength(2);
    // Not vacuous: items really were processed, and the first of them landed
    // before the second batch was ever fetched.
    expect(events.filter((e) => e === 'item')).toHaveLength(count);
    expect(events.indexOf('item')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('item')).toBeLessThan(events.lastIndexOf('query'));
  });

  it('asks for ids in sorted order, so concatenated batches are globally ordered', async () => {
    const f = fakeCtx();
    const seen: string[][] = [];
    f.tx.evidenceItem.findMany.mockImplementation((args: Record<string, unknown>) => {
      seen.push((args['where'] as { id: { in: string[] } }).id.in);
      return Promise.resolve([]);
    });
    const shuffled = [uuid(9), uuid(3), uuid(7), uuid(1)];

    for await (const _ of loadItemsInBatches(f.ctx, TENANT, shuffled)) {
      // draining the generator is the point
    }

    expect(seen[0]).toEqual([uuid(1), uuid(3), uuid(7), uuid(9)]);
  });
});

describe('native export records a digest for each archive part', () => {
  /**
   * `putDerivative` has always returned a SHA-256 per part and this processor
   * used to throw it away. The manifest hashes every ITEM, which proves the
   * contents once extracted, and says nothing about whether a 2 GiB part
   * arrived intact — so a recipient of a 65-part download had no way to spot a
   * truncated part short of unzipping all of it.
   */
  it('writes one export_parts row per part, in the ready transaction', async () => {
    const f = fakeCtx();
    const { writer } = arm(f);
    f.store.putDerivative.mockImplementation(
      (_t: string, _e: string, type: string, version: number) =>
        Promise.resolve({
          objectKey: `key/${type}/${String(version)}`,
          sha256: `${type}${String(version)}`.padEnd(64, '0'),
          size: 4096,
        }),
    );

    await processExportRun(f.ctx, payload, { createArchive: () => writer });

    expect(f.tx.exportPart.createMany).toHaveBeenCalledTimes(1);
    const rows = (
      f.tx.exportPart.createMany.mock.calls[0]?.[0] as {
        data: { partNumber: number; sha256: string; sizeBytes: bigint }[];
      }
    ).data;
    // A single-part export never rotates, so the final part is the only one —
    // and it is recorded outside rotatePart or not at all.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.partNumber).toBe(1);
    expect(rows[0]?.sha256).toBe('archive1'.padEnd(64, '0'));
    expect(rows[0]?.sizeBytes).toBe(4096n);
  });

  it('records the CSV object as the single downloadable part, plus a sidecar manifest', async () => {
    const f = fakeCtx();
    const { writer } = arm(f);
    f.tx.export.findUnique.mockResolvedValue({
      id: EXPORT_ID,
      kind: 'csv',
      status: 'queued',
      parameters: {
        selection: { kind: 'items', evidenceItemIds: [GOOD_ID] },
        includeFamilies: false,
        archiveSplitMb: 2048,
        csv: { columns: ['evidence_id', 'name'], delimiter: ',' },
      },
    });
    f.store.putDerivative.mockImplementation(
      (_t: string, _e: string, type: string, version: number, filename: string) =>
        Promise.resolve({
          objectKey: `key/${type}/${String(version)}/${filename}`,
          sha256: `${type}`.padEnd(64, '0'),
          size: type === 'export-csv' ? 88 : 32,
        }),
    );

    await processExportRun(f.ctx, payload, { createArchive: () => writer });

    const puts = f.store.putDerivative.mock.calls as unknown as [
      string,
      string,
      string,
      number,
      string,
    ][];
    expect(puts.some((c) => c[2] === 'export-csv' && c[4] === 'export.csv')).toBe(true);
    expect(puts.some((c) => c[2] === 'export-manifest' && c[4] === 'manifest.json')).toBe(true);

    expect(f.tx.exportPart.createMany).toHaveBeenCalledTimes(1);
    const rows = (
      f.tx.exportPart.createMany.mock.calls[0]?.[0] as {
        data: { partNumber: number; objectKey: string; sha256: string; sizeBytes: bigint }[];
      }
    ).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.partNumber).toBe(1);
    expect(rows[0]?.objectKey).toBe('key/export-csv/1/export.csv');
    expect(rows[0]?.sha256).toBe('export-csv'.padEnd(64, '0'));
    expect(rows[0]?.sizeBytes).toBe(88n);
  });
});

describe('buildFamilyIndex', () => {
  it('collects attachment parents and names only those inside the export', async () => {
    const f = fakeCtx();
    const parent = uuid(1);
    const child = uuid(2);
    const outsider = uuid(99);
    f.tx.evidenceRelationship.findMany.mockResolvedValue([
      { parentId: parent },
      { parentId: outsider },
    ]);
    f.tx.evidenceItem.findMany.mockResolvedValue([{ id: parent, name: 'Message.eml' }]);

    const index = await buildFamilyIndex(f.ctx, TENANT, [parent, child], 'extracted');

    expect(index.parents.has(parent)).toBe(true);
    expect(index.nameById.get(parent)).toBe('Message.eml');
    // A parent outside the selection was never in the old map either, so it is
    // not queried and keeps the 'family' fallback.
    const asked = f.tx.evidenceItem.findMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
    };
    expect(asked.where.id.in).toEqual([parent]);
  });

  it('does no work at all for an empty selection', async () => {
    const f = fakeCtx();
    const index = await buildFamilyIndex(f.ctx, TENANT, [], 'inline');
    expect(index.parents.size).toBe(0);
    expect(f.tx.evidenceRelationship.findMany).not.toHaveBeenCalled();
  });

  it('decides a parent path up front only for the inline layout', async () => {
    const f = fakeCtx();
    const parent = uuid(1);
    f.tx.evidenceRelationship.findMany.mockResolvedValue([{ parentId: parent }]);
    f.tx.evidenceItem.findMany.mockResolvedValue([
      { id: parent, name: 'Msg.eml', kind: 'email', custodian: { email: 'user@example.com' } },
    ]);

    // Items stream in id order, so an attachment is often reached before the
    // email it came from. The child cannot wait for the parent to be written,
    // so the parent's path has to be known before the stream starts.
    const inline = await buildFamilyIndex(f.ctx, TENANT, [parent], 'inline');
    expect(inline.pathById.get(parent)).toBe('custodian/user@example.com/Msg.eml');

    // The extracted layout writes children into their own directories and has
    // no need to name the parent early, so it does not.
    const extracted = await buildFamilyIndex(f.ctx, TENANT, [parent], 'extracted');
    expect(extracted.pathById.size).toBe(0);
  });

  it('puts a child under its parent\u2019s directory when asked for extracted', async () => {
    const f = fakeCtx();
    const parent = uuid(1);
    const child = uuid(2);
    const { append } = armFamily(f, {
      ids: [parent, child],
      attachments: 'extracted',
      rows: [
        row(parent, { name: 'Msg.eml', kind: 'email', blob: null }),
        row(child, { name: 'att.pdf', ...attachmentOf(parent), blob: null }),
      ],
      relationships: [{ parentId: parent, childId: child }],
    });

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const paths = f.tx.exportItem.upsert.mock.calls.map(
      (c) => (c[0] as { create: { archivePath: string } }).create.archivePath,
    );
    const dir = `Msg.eml-${parent.slice(0, 8)}`;
    expect(paths).toContain(`custodian/user@example.com/${dir}/att.pdf`);
    expect(paths).toContain(`custodian/user@example.com/${dir}/Msg.eml`);
  });
});

// ---------------------------------------------------------------------------
// Native export: attachments stay inside the parent email
// ---------------------------------------------------------------------------

function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...evidenceRow(id, GOOD_SHA), ...over };
}

/** Mark an item as an attachment carved out of `parentId` by the parser. */
function attachmentOf(parentId: string): Record<string, unknown> {
  return { kind: 'attachment', childRelationships: [{ parentId, kind: 'attachment' }] };
}

function writerOf(append: ReturnType<typeof vi.fn>): ArchiveWriterLike {
  return { append, finalize: vi.fn().mockResolvedValue({ entryCount: 0 }) };
}

/**
 * Arm a native export over an explicit set of rows.
 *
 * Both queries are answered from the SAME rows: the `select`-shaped one that
 * buildFamilyIndex makes for parent names, and the `include`-shaped one the
 * item stream makes. Two separate fixtures could disagree about an item, and
 * the bug this file guards against is exactly a disagreement about where an
 * item lives.
 */
function armFamily(
  f: FakeCtx,
  opts: {
    ids: string[];
    rows: Record<string, unknown>[];
    relationships: { parentId: string; childId: string }[];
    attachments?: 'inline' | 'extracted';
  },
): { append: ReturnType<typeof vi.fn> } {
  f.tx.export.findUnique.mockResolvedValue({
    id: EXPORT_ID,
    kind: 'native',
    status: 'queued',
    parameters: {
      selection: { kind: 'items', evidenceItemIds: opts.ids },
      includeFamilies: false,
      attachments: opts.attachments ?? 'inline',
      archiveSplitMb: 2048,
    },
  });
  f.tx.evidenceRelationship.findMany.mockImplementation((args: Record<string, unknown>) => {
    const where = args['where'] as { childId: { in: string[] } };
    const wanted = new Set(where.childId.in);
    return Promise.resolve(
      opts.relationships
        .filter((r) => wanted.has(r.childId))
        .map((r) => ({ parentId: r.parentId })),
    );
  });
  const byId = new Map(opts.rows.map((r) => [r['id'] as string, r]));
  f.tx.evidenceItem.findMany.mockImplementation((args: Record<string, unknown>) => {
    const where = args['where'] as { id: { in: string[] } };
    const found = where.id.in.map((id) => byId.get(id)).filter((r) => r !== undefined);
    if (args['select'] !== undefined) {
      return Promise.resolve(
        found.map((r) => ({
          id: r['id'],
          name: r['name'],
          kind: r['kind'],
          custodian: r['custodian'],
        })),
      );
    }
    return Promise.resolve(found);
  });
  f.store.getStream.mockImplementation(() => Promise.resolve(Readable.from(GOOD_CONTENT)));
  return { append: vi.fn() };
}

interface ManifestShape {
  itemCount: number;
  verifiedCount: number;
  inlineAttachmentCount: number;
  items: {
    evidenceItemId: string;
    placement: string;
    archivePath: string;
    containerPath: string;
    containerItemId: string;
    note: string;
    verified: boolean;
  }[];
}

function appended(append: ReturnType<typeof vi.fn>, name: string): string {
  const call = append.mock.calls.find((c) => c[0] === name);
  return call === undefined ? '' : String(call[1]);
}

function manifestOf(append: ReturnType<typeof vi.fn>): ManifestShape {
  return JSON.parse(appended(append, 'manifest.json')) as ManifestShape;
}

describe('native export leaves email attachments inside the parent', () => {
  const parent = uuid(1);
  const child = uuid(2);
  const parentPath = 'custodian/user@example.com/Msg.eml';

  function armPair(f: FakeCtx): { append: ReturnType<typeof vi.fn> } {
    return armFamily(f, {
      ids: [parent, child],
      rows: [
        row(parent, { name: 'Msg.eml', kind: 'email' }),
        row(child, { name: 'invoice.pdf', ...attachmentOf(parent) }),
      ],
      relationships: [{ parentId: parent, childId: child }],
    });
  }

  it('writes the .eml and does not write the attachment as a second file', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const paths = append.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain(parentPath);
    // The whole point: those bytes are already inside the .eml above.
    expect(paths.some((p) => p.endsWith('invoice.pdf'))).toBe(false);
    // And the directory named after the email subject is gone with it.
    expect(paths.some((p) => p.includes(`Msg.eml-${parent.slice(0, 8)}/`))).toBe(false);
  });

  it('still gives the attachment a manifest row that names the file it is in', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const manifest = manifestOf(append);
    expect(manifest.itemCount).toBe(2);
    expect(manifest.inlineAttachmentCount).toBe(1);

    const entry = manifest.items.find((i) => i.evidenceItemId === child);
    expect(entry?.placement).toBe('inline');
    expect(entry?.containerPath).toBe(parentPath);
    expect(entry?.containerItemId).toBe(parent);
    // A path that is not in the zip would send a reviewer looking for a file
    // that does not exist, which is worse than saying there is not one.
    expect(entry?.archivePath).toBe('');
    // Never hashed separately, so never claimed as verified.
    expect(entry?.verified).toBe(false);
  });

  it('keeps hashlist.txt to files that really are in the archive', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const written = new Set(append.mock.calls.map((c) => c[0] as string));
    const listed = appended(append, 'hashlist.txt')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.slice(l.indexOf('  ') + 2));
    expect(listed).toContain(parentPath);
    // `sha256sum -c` must not be handed a path it cannot open. GNU coreutils
    // answers a comment line with "WARNING: N lines are improperly formatted",
    // so the inline digests live in their own file instead.
    for (const path of listed) expect(written.has(path)).toBe(true);

    const inline = appended(append, 'inline-attachments.csv');
    expect(inline).toContain(child);
    expect(inline).toContain(parentPath);

    // An attachment that was never hashed is not an exception; only real
    // failures belong there, or the handful that matter get buried.
    expect(appended(append, 'exceptions.csv')).not.toContain(child);
  });

  it('counts the attachment as delivered and says why the file count is lower', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const final = f.tx.export.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    // Both items were delivered: one as a file, one inside it.
    expect(final.data['itemCount']).toBe(2);
    const detail = String(final.data['statusDetail']);
    expect(detail).toContain('2 items');
    expect(detail).toContain('1 file(s)');
    expect(detail).toContain('1 attachment(s)');
    expect(detail).toContain('inline-attachments.csv');
  });

  it('records the attachment against the file that contains it, not a path', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const rows = f.tx.exportItem.upsert.mock.calls.map(
      (c) => c[0] as { create: { archivePath: string; state: string; verified: boolean } },
    );
    const childRow = rows.find((r) => r.create.archivePath.startsWith('inside:'));
    expect(childRow?.create.archivePath).toBe(`inside:${parentPath}`);
    expect(childRow?.create.state).toBe('written');
    expect(childRow?.create.verified).toBe(false);
  });

  /**
   * The case that loses evidence if it is got wrong.
   *
   * Someone tags ONE attachment and exports just that. There is no parent
   * `.eml` in the selection for it to be inside, so skipping it because it
   * "has a parent" produces an empty export and tells the reviewer nothing.
   */
  it('writes an attachment as its own file when its parent is NOT in the export', async () => {
    const f = fakeCtx();
    const { append } = armFamily(f, {
      ids: [child],
      rows: [row(child, { name: 'invoice.pdf', ...attachmentOf(parent) })],
      relationships: [{ parentId: parent, childId: child }],
    });

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const paths = append.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain('custodian/user@example.com/invoice.pdf');

    const manifest = manifestOf(append);
    expect(manifest.inlineAttachmentCount).toBe(0);
    const entry = manifest.items.find((i) => i.evidenceItemId === child);
    expect(entry?.placement).toBe('file');
    expect(entry?.verified).toBe(true);
    // And the reviewer is told why this one is loose when others are not.
    expect(entry?.note).toContain('parent native is not in this export');

    expect(appended(append, 'hashlist.txt')).toContain('custodian/user@example.com/invoice.pdf');
    const final = f.tx.export.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(final.data['itemCount']).toBe(1);
  });

  /**
   * Being in the SELECTION is not the same as being in the ARCHIVE. A parent
   * with no preserved native bytes is recorded as failed and never written, so
   * anything filed as "inside it" would be nowhere at all.
   */
  it('writes attachments standalone when the parent itself could not be exported', async () => {
    const f = fakeCtx();
    const { append } = armFamily(f, {
      ids: [parent, child],
      rows: [
        row(parent, { name: 'Msg.eml', kind: 'email', blob: null }),
        row(child, { name: 'invoice.pdf', ...attachmentOf(parent) }),
      ],
      relationships: [{ parentId: parent, childId: child }],
    });

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const paths = append.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain('custodian/user@example.com/invoice.pdf');

    const manifest = manifestOf(append);
    expect(manifest.inlineAttachmentCount).toBe(0);
    const entry = manifest.items.find((i) => i.evidenceItemId === child);
    expect(entry?.placement).toBe('file');
    expect(entry?.note).toContain('parent native could not be exported');
    // The parent is still reported as the failure it is.
    expect(appended(append, 'exceptions.csv')).toContain(parent);
  });

  it('leaves a standalone file alone: it is not an attachment of anything', async () => {
    const f = fakeCtx();
    const loose = uuid(7);
    const { append } = armFamily(f, {
      ids: [loose],
      rows: [row(loose, { name: 'budget.xlsx', kind: 'file' })],
      relationships: [],
    });

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    expect(append.mock.calls.map((c) => c[0] as string)).toContain(
      'custodian/user@example.com/budget.xlsx',
    );
    const manifest = manifestOf(append);
    expect(manifest.inlineAttachmentCount).toBe(0);
    expect(manifest.items.find((i) => i.evidenceItemId === loose)?.placement).toBe('file');
  });

  it('README explains the gap between the item count and the file count', async () => {
    const f = fakeCtx();
    const { append } = armPair(f);

    await processExportRun(f.ctx, payload, { createArchive: () => writerOf(append) });

    const readme = appended(append, 'README.txt');
    expect(readme).toContain('Attachment layout: inline');
    expect(readme).toContain('inline-attachments.csv');
    expect(readme).toContain('RFC822');
  });
});
