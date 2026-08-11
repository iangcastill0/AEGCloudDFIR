import { describe, expect, it } from 'vitest';
import { TENANT, fakeCtx } from './testing/fakes.js';
import { withJobAttempt } from './job-attempts.js';

const job = { id: 'job-1', attemptsMade: 2, data: { tenantId: TENANT } };

describe('withJobAttempt', () => {
  it('creates a running attempt row and closes it as succeeded', async () => {
    const f = fakeCtx();
    f.tx.jobAttempt.create.mockResolvedValue({ id: 'attempt-1' });

    const result = await withJobAttempt(f.ctx, 'collection.fetch-item', job, () =>
      Promise.resolve('done'),
    );

    expect(result).toBe('done');
    const createData = (
      f.tx.jobAttempt.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(createData).toMatchObject({
      tenantId: TENANT,
      queue: 'collection.fetch-item',
      jobId: 'job-1',
      attempt: 3,
      status: 'running',
    });
    expect(String(createData['workerId'])).toContain(':');
    expect(f.tx.jobAttempt.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'attempt-1' },
        data: expect.objectContaining({ status: 'succeeded', error: '' }),
      }),
    );
  });

  it('closes the attempt as failed with a sanitized error and rethrows', async () => {
    const f = fakeCtx();
    f.tx.jobAttempt.create.mockResolvedValue({ id: 'attempt-2' });

    await expect(
      withJobAttempt(f.ctx, 'process.parse', job, () =>
        Promise.reject(new Error('boom https://api.example.com/path?token=secret')),
      ),
    ).rejects.toThrow('boom');

    const closeData = (
      f.tx.jobAttempt.update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(closeData['status']).toBe('failed');
    expect(String(closeData['error'])).not.toContain('token=secret');
    expect(String(closeData['error'])).toContain('?[elided]');
  });

  it('rejects payloads without a tenantId before running the processor', async () => {
    const f = fakeCtx();
    await expect(
      withJobAttempt(f.ctx, 'process.parse', { id: 'x', attemptsMade: 0, data: {} }, () =>
        Promise.resolve('never'),
      ),
    ).rejects.toThrow('tenantId');
    expect(f.tx.jobAttempt.create).not.toHaveBeenCalled();
  });

  it('still runs the processor when bookkeeping itself fails', async () => {
    const f = fakeCtx();
    f.tx.jobAttempt.create.mockRejectedValue(new Error('db down'));
    const result = await withJobAttempt(f.ctx, 'search.index', job, () => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
