import { describe, expect, it } from 'vitest';
import { verifyManifestSignature, type CollectionManifestV1 } from '@evidencevault/evidence';
import { COLLECTION, CUSTODIAN, TENANT, fakeCtx, type FakeCtx } from '../testing/fakes.js';
import {
  buildCompletenessNarrative,
  decideCompleteness,
  processCollectionFinalize,
} from './collection-finalize.js';

const payload = { tenantId: TENANT, collectionId: COLLECTION };
const SHA = 'a'.repeat(64);

function arm(
  f: FakeCtx,
  opts: {
    status?: string;
    grouped?: { state: string; _count: { _all: number } }[];
    exceptions?: Record<string, unknown>[];
    pageCheckpoints?: number;
    dateRange?: Record<string, unknown>;
    kind?: string;
  } = {},
): void {
  f.tx.collection.findUnique.mockResolvedValue({
    id: COLLECTION,
    name: 'Investigation A',
    kind: opts.kind ?? 'snapshot',
    status: opts.status ?? 'fetching',
    scope: { dateRange: opts.dateRange ?? { kind: 'all_time' } },
    startedAt: new Date('2026-01-01T00:00:00Z'),
    connectorAccountId: 'acct',
    custodians: [
      {
        custodian: { id: CUSTODIAN, email: 'user@example.com', displayName: 'User' },
      },
    ],
    connectorAccount: {
      provider: 'microsoft',
      mode: 'delegated',
      label: 'Mailbox',
      externalIdentity: 'user@example.com',
    },
  });
  f.tx.collectionItem.groupBy.mockResolvedValue(
    opts.grouped ?? [{ state: 'preserved', _count: { _all: 2 } }],
  );
  f.tx.collectionCheckpoint.count.mockResolvedValue(opts.pageCheckpoints ?? 0);
  f.tx.collectionException.findMany.mockResolvedValue(opts.exceptions ?? []);
  f.tx.evidenceItem.findMany.mockResolvedValue([
    {
      id: 'ev-1',
      providerItemId: 'm1',
      custodianId: CUSTODIAN,
      sha256: SHA,
      size: 10n,
      blob: { objectKey: `tenants/${TENANT}/originals/sha256/aa/${SHA}` },
      acquiredAt: new Date('2026-01-02T00:00:00Z'),
      isApiExportDerivative: false,
    },
  ]);
}

function storedEnvelope(f: FakeCtx): { manifest: CollectionManifestV1; signature: { signature: string } } {
  const call = f.store.putManifest.mock.calls[0];
  expect(call).toBeDefined();
  return JSON.parse(call?.[2] as string) as {
    manifest: CollectionManifestV1;
    signature: { signature: string };
  };
}

describe('processCollectionFinalize', () => {
  it('is a no-op while items or page checkpoints remain in flight', async () => {
    const f = fakeCtx();
    arm(f, { grouped: [{ state: 'discovered', _count: { _all: 3 } }] });
    await processCollectionFinalize(f.ctx, payload);
    expect(f.store.putManifest).not.toHaveBeenCalled();
    expect(f.tx.collection.update).not.toHaveBeenCalled();
  });

  it('still waits when a scope checkpoint has not exhausted pagination', async () => {
    const f = fakeCtx();
    arm(f, { pageCheckpoints: 1 });
    await processCollectionFinalize(f.ctx, payload);
    expect(f.store.putManifest).not.toHaveBeenCalled();
  });

  it('records complete_with_exceptions and the all-time caveat in the signed manifest', async () => {
    const f = fakeCtx();
    arm(f, {
      exceptions: [
        {
          kind: 'permission_denied',
          message: 'recoverable items not accessible',
          providerItemId: '',
          custodianId: CUSTODIAN,
        },
      ],
    });

    await processCollectionFinalize(f.ctx, payload);

    const { manifest, signature } = storedEnvelope(f);
    expect(manifest.completeness).toBe('complete_with_exceptions');
    expect(manifest.items.map((i) => i.sha256)).toEqual([SHA]);
    expect(manifest.completenessNarrative).toContain('purged or altered before acquisition');
    expect(manifest.exceptions[0]?.kind).toBe('permission_denied');
    // Signature covers the exact canonical bytes we stored.
    const serialized = (f.store.putManifest.mock.calls[0]?.[2] as string)
      .replace(/^\{"manifest":/, '')
      .replace(/,"signature":.*\}$/, '');
    expect(
      verifyManifestSignature(serialized, signature.signature, f.ctx.manifestSigningKey),
    ).toBe(true);
    // Completeness report stored beside the manifest.
    expect(f.store.putDerivative).toHaveBeenCalledWith(
      TENANT,
      COLLECTION,
      'completeness-report',
      1,
      'report.txt',
      expect.any(Buffer),
      expect.stringContaining('text/plain'),
    );
    expect(f.tx.collection.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          completeness: 'complete_with_exceptions',
        }),
      }),
    );
  });

  it('zero preserved with errors finalizes as failed', async () => {
    const f = fakeCtx();
    arm(f, { grouped: [{ state: 'failed', _count: { _all: 2 } }] });
    f.tx.evidenceItem.findMany.mockResolvedValue([]);
    await processCollectionFinalize(f.ctx, payload);
    expect(storedEnvelope(f).manifest.completeness).toBe('failed');
    expect(f.tx.collection.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', completeness: 'failed' }),
      }),
    );
  });

  it('a cancelling collection finalizes as cancelled', async () => {
    const f = fakeCtx();
    arm(f, { status: 'cancelling' });
    await processCollectionFinalize(f.ctx, payload);
    expect(storedEnvelope(f).manifest.completeness).toBe('cancelled');
    expect(f.tx.collection.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled', completeness: 'cancelled' }),
      }),
    );
  });
});

describe('decideCompleteness', () => {
  it('applies the honest vocabulary in priority order', () => {
    expect(
      decideCompleteness({ wasCancelling: true, preserved: 5, errors: 0, exceptionCount: 0 }),
    ).toBe('cancelled');
    expect(
      decideCompleteness({ wasCancelling: false, preserved: 0, errors: 3, exceptionCount: 0 }),
    ).toBe('failed');
    expect(
      decideCompleteness({ wasCancelling: false, preserved: 4, errors: 1, exceptionCount: 0 }),
    ).toBe('partial');
    expect(
      decideCompleteness({ wasCancelling: false, preserved: 4, errors: 0, exceptionCount: 2 }),
    ).toBe('complete_with_exceptions');
    expect(
      decideCompleteness({ wasCancelling: false, preserved: 4, errors: 0, exceptionCount: 0 }),
    ).toBe('complete_within_selected_api_scope');
  });
});

describe('buildCompletenessNarrative', () => {
  it('includes the all-time truthfulness caveat only for all_time scopes', () => {
    const base = {
      completeness: 'complete_within_selected_api_scope' as const,
      preserved: 2,
      discovered: 2,
      errors: 0,
      skipped: 0,
      exceptionCount: 0,
      provider: 'microsoft',
      mode: 'delegated',
    };
    expect(buildCompletenessNarrative({ ...base, allTimeScope: true })).toContain(
      'purged or altered before acquisition',
    );
    expect(buildCompletenessNarrative({ ...base, allTimeScope: false })).not.toContain(
      'purged or altered before acquisition',
    );
  });
});
