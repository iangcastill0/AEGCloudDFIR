import { describe, expect, it, vi } from 'vitest';
import type { TenantScopedTx } from '@aeg-clouddfir/database';
import {
  STALLED_REASON,
  failureTargetFor,
  isTerminalFailure,
  recordTerminalFailure,
} from './terminal-failure';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const COLLECTION = '00000000-0000-4000-8000-0000000000bb';
const CUSTODIAN = '00000000-0000-4000-8000-0000000000cc';

describe('isTerminalFailure', () => {
  it('is true for a stalled job even on its first attempt', () => {
    // This is the case that let a collection hang for 20 hours. A deploy
    // restarted the worker mid-fetch, BullMQ failed 8 jobs as stalled with
    // attemptsMade below the retry limit, and nothing marked the items failed.
    expect(isTerminalFailure({ reason: STALLED_REASON, attemptsMade: 1, attempts: 8 })).toBe(true);
  });

  it('is true when the retries are exhausted', () => {
    expect(isTerminalFailure({ reason: 'HTTP 500', attemptsMade: 8, attempts: 8 })).toBe(true);
  });

  it('is false mid-retry, so a job that will run again is left alone', () => {
    expect(isTerminalFailure({ reason: 'HTTP 429', attemptsMade: 2, attempts: 8 })).toBe(false);
  });

  it('recognises a stalled failure however it is worded around the message', () => {
    expect(
      isTerminalFailure({
        reason: `Error: ${STALLED_REASON}`,
        attemptsMade: 1,
        attempts: 8,
      }),
    ).toBe(true);
  });
});

describe('failureTargetFor', () => {
  it('locates the collection item behind a fetch-item job', () => {
    expect(
      failureTargetFor('collection.fetch-item', {
        tenantId: TENANT,
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        source: 'email',
        providerItemId: '19cde6027c010290',
      }),
    ).toEqual({
      kind: 'collection-item',
      tenantId: TENANT,
      collectionId: COLLECTION,
      custodianId: CUSTODIAN,
      source: 'email',
      providerItemId: '19cde6027c010290',
    });
  });

  it('locates the evidence item behind an OCR job', () => {
    expect(
      failureTargetFor('process.ocr', {
        tenantId: TENANT,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      }),
    ).toEqual({
      kind: 'evidence-item',
      tenantId: TENANT,
      evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
    });
    expect(
      failureTargetFor('process.ocr.image', {
        tenantId: TENANT,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      }),
    ).toEqual({
      kind: 'evidence-item',
      tenantId: TENANT,
      evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
    });
  });

  it('locates the import behind an analysis job', () => {
    expect(
      failureTargetFor('import.analyze', {
        tenantId: TENANT,
        importId: '00000000-0000-4000-8000-0000000000ee',
      }),
    ).toEqual({
      kind: 'forensic-import',
      tenantId: TENANT,
      importId: '00000000-0000-4000-8000-0000000000ee',
    });
  });

  it('locates the container behind a pst.extract job', () => {
    expect(
      failureTargetFor('pst.extract', {
        tenantId: TENANT,
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      }),
    ).toEqual({
      kind: 'pst-extract',
      tenantId: TENANT,
      collectionId: COLLECTION,
      custodianId: CUSTODIAN,
      evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
    });
  });

  it('returns null for a queue with nothing to mark', () => {
    expect(failureTargetFor('dead-letter', { tenantId: TENANT })).toBeNull();
  });

  it('returns null rather than guessing when the payload is not what we expect', () => {
    expect(failureTargetFor('collection.fetch-item', { tenantId: TENANT })).toBeNull();
    expect(failureTargetFor('process.parse', {})).toBeNull();
  });
});

interface Recorded {
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
  exception: ReturnType<typeof vi.fn>;
  evidenceFindFirst: ReturnType<typeof vi.fn>;
  evidenceUpdate: ReturnType<typeof vi.fn>;
}

function fakeCtx(
  itemRow: Record<string, unknown> | null = { id: 'item-1' },
  evidenceRow: Record<string, unknown> | null = null,
) {
  const recorded: Recorded = {
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findFirst: vi.fn(async () => itemRow),
    progress: vi.fn(async () => ({})),
    exception: vi.fn(async () => ({})),
    evidenceFindFirst: vi.fn(async () => evidenceRow),
    evidenceUpdate: vi.fn(async () => ({})),
  };
  const tx = {
    // withTenantContext and incrementProgress both go through $executeRaw.
    $executeRaw: vi.fn(async () => 0),
    collectionItem: {
      findFirst: recorded.findFirst,
      update: recorded.update,
      updateMany: recorded.updateMany,
    },
    collectionCustodian: {
      findUnique: vi.fn(async () => ({ progress: {} })),
      update: recorded.progress,
    },
    collectionException: { create: recorded.exception },
    evidenceItem: {
      findFirst: recorded.evidenceFindFirst,
      update: recorded.evidenceUpdate,
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  } as unknown as TenantScopedTx;

  const ctx = {
    prisma: {
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as Parameters<typeof recordTerminalFailure>[0];

  return { ctx, recorded };
}

describe('recordTerminalFailure', () => {
  it('marks a stalled collection item failed, so the collection can finish', async () => {
    const { ctx, recorded } = fakeCtx();
    await recordTerminalFailure(
      ctx,
      {
        kind: 'collection-item',
        tenantId: TENANT,
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        source: 'email',
        providerItemId: '19cde6027c010290',
      },
      STALLED_REASON,
    );

    expect(recorded.update).toHaveBeenCalled();
    const arg = recorded.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data['state']).toBe('failed');
    expect(String(arg.data['lastError'])).toContain('stalled');
  });

  it('does nothing when the item is already in a terminal state', async () => {
    // The processor's own catch may have recorded the failure first; this must
    // not double-count it in the ledger.
    const { ctx, recorded } = fakeCtx(null);
    await recordTerminalFailure(
      ctx,
      {
        kind: 'collection-item',
        tenantId: TENANT,
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        source: 'email',
        providerItemId: 'already-done',
      },
      STALLED_REASON,
    );

    expect(recorded.update).not.toHaveBeenCalled();
  });

  it('marks extracted evidence an exception when OCR stalls, so Retry can recover it', async () => {
    // Extract already wrote file_text and queued the once-ever OCR key. A
    // deploy kill then left the item `extracted`; Retry only looks at
    // exception, and re-queueing extract is a no-op.
    const { ctx, recorded } = fakeCtx(
      { id: 'item-1' },
      {
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        providerItemId: 'drive:scan.pdf',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        size: 12_345,
        processingStatus: 'extracted',
      },
    );

    await recordTerminalFailure(
      ctx,
      {
        kind: 'evidence-item',
        tenantId: TENANT,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      },
      STALLED_REASON,
    );

    expect(recorded.evidenceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: 'exception' }),
      }),
    );
    const exceptionArg = recorded.exception.mock.calls[0]?.[0] as {
      data: { detail: { evidenceItemId: string } };
    };
    expect(exceptionArg.data.detail.evidenceItemId).toBe('00000000-0000-4000-8000-0000000000dd');
  });

  it('leaves pending parse evidence pending so the sweeper can still recover it', async () => {
    const { ctx, recorded } = fakeCtx(
      { id: 'item-1' },
      { collectionId: COLLECTION, processingStatus: 'pending' },
    );

    await recordTerminalFailure(
      ctx,
      {
        kind: 'evidence-item',
        tenantId: TENANT,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      },
      STALLED_REASON,
    );

    expect(recorded.evidenceUpdate).not.toHaveBeenCalled();
    expect(recorded.exception).not.toHaveBeenCalled();
  });

  it('marks the PST container failed and pending evidence an exception', async () => {
    const { ctx, recorded } = fakeCtx();
    await recordTerminalFailure(
      ctx,
      {
        kind: 'pst-extract',
        tenantId: TENANT,
        collectionId: COLLECTION,
        custodianId: CUSTODIAN,
        evidenceItemId: '00000000-0000-4000-8000-0000000000dd',
      },
      STALLED_REASON,
    );

    expect(recorded.update).toHaveBeenCalled();
    const itemArg = recorded.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(itemArg.data['state']).toBe('failed');
    expect(recorded.exception).toHaveBeenCalled();
  });
});
