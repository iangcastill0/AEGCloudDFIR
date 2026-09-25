import { beforeEach, describe, expect, it } from 'vitest';
import { COLLECTION, EVIDENCE, TENANT, fakeCtx, silentLog } from '../testing/fakes.js';
import {
  recordMissingObject,
  isMissingObjectDetail,
  type MissingObjectItem,
} from './missing-object.js';

const KEY = `tenants/${TENANT}/originals/sha256/aa/${'a'.repeat(64)}`;

function item(overrides: Partial<MissingObjectItem> = {}): MissingObjectItem {
  return {
    id: EVIDENCE,
    name: 'report.pdf',
    collectionId: COLLECTION,
    custodianId: null,
    providerItemId: 'p1',
    ...overrides,
  };
}

beforeEach(() => {
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
});

describe('recordMissingObject', () => {
  it('marks the item as an exception and says why, in the item itself', async () => {
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'extract',
      bucket: 'evidence',
      objectKey: KEY,
    });

    const update = f.tx.evidenceItem.update.mock.calls[0]?.[0] as {
      data: { processingStatus: string; processingDetail: string };
    };
    expect(update.data.processingStatus).toBe('exception');
    expect(update.data.processingDetail).toContain('MISSING');
    expect(update.data.processingDetail).toContain(KEY);
  });

  it('leaves malwareStatus alone unless the scanner itself was the one that could not read it', async () => {
    // An item that scanned clean months ago and lost its bytes yesterday WAS
    // scanned clean. Overwriting that from the extract or preview stage would
    // destroy a true fact and contradict its own MalwareScan row.
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'preview',
      bucket: 'evidence',
      objectKey: KEY,
    });
    const data = (f.tx.evidenceItem.update.mock.calls[0]?.[0] as { data: Record<string, unknown> })
      .data;
    expect(data).not.toHaveProperty('malwareStatus');

    const g = fakeCtx();
    await recordMissingObject(g.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'scan',
      bucket: 'evidence',
      objectKey: KEY,
      malwareUnscannable: true,
    });
    expect(
      (g.tx.evidenceItem.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data,
    ).toMatchObject({ malwareStatus: 'object_missing' });
  });

  it('writes ONE ledger row when several stages hit the same absent object', async () => {
    // scan, extract and preview all run off the same fetch and all fail within
    // seconds of each other. One item with no bytes is one problem; three rows
    // would treble the count an operator and a disclosure report read off this
    // table.
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'scan',
      bucket: 'evidence',
      objectKey: KEY,
    });
    expect(f.tx.collectionException.create).toHaveBeenCalledTimes(1);

    // Second stage arrives and finds the row already there.
    f.tx.collectionException.findFirst.mockResolvedValue({ id: 'existing' });
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'extract',
      bucket: 'evidence',
      objectKey: KEY,
    });
    expect(f.tx.collectionException.create).toHaveBeenCalledTimes(1);
  });

  it('still marks an item that belongs to no collection', async () => {
    // Uploads and derivatives can have no collectionId. The ledger is
    // per-collection, so without the item-level mark they would record nothing.
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item({ collectionId: null }),
      version: 1,
      stage: 'scan',
      bucket: 'evidence',
      objectKey: KEY,
    });
    expect(f.tx.collectionException.create).not.toHaveBeenCalled();
    expect(f.tx.evidenceItem.update).toHaveBeenCalled();
  });

  it('re-indexes, so Review stops presenting the item as ordinary', async () => {
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 3,
      stage: 'ocr',
      bucket: 'evidence',
      objectKey: KEY,
    });
    const rows = (
      f.tx.outboxEvent.createMany.mock.calls[0]?.[0] as {
        data: { topic: string; dedupKey: string }[];
      }
    ).data;
    expect(rows[0]?.topic).toBe('search.index');
    // Stage in the key, or a second stage's re-index is collapsed against the
    // first and the corrected status never reaches the index.
    expect(rows[0]?.dedupKey).toContain('ocr-object-missing');
  });

  it('logs at error level, not warn', async () => {
    // This is the one condition here that means evidence is lost. It has to be
    // findable in a log search that filters warnings out.
    const f = fakeCtx();
    await recordMissingObject(f.ctx, {
      tenantId: TENANT,
      item: item(),
      version: 1,
      stage: 'scan',
      bucket: 'evidence',
      objectKey: KEY,
    });
    expect(silentLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey: KEY, stage: 'scan' }),
      'evidence object is MISSING from object storage',
    );
    expect(silentLog.warn).not.toHaveBeenCalled();
  });
});

describe('isMissingObjectDetail', () => {
  it('recognises the detail recordMissingObject writes', () => {
    expect(
      isMissingObjectDetail(
        `evidence object is MISSING from evidence object storage (key ${KEY}).`,
      ),
    ).toBe(true);
    expect(isMissingObjectDetail('Tika returned 422')).toBe(false);
  });
});
