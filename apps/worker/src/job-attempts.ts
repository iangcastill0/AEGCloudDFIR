import { hostname } from 'node:os';
import { z } from 'zod';
import { withTenantContext } from '@evidencevault/database';
import { sanitizeError, type WorkerContext } from './context.js';

export const HEARTBEAT_INTERVAL_MS = 15_000;

const tenantPayload = z.object({ tenantId: z.string().uuid() });

export interface JobLike {
  id?: string;
  attemptsMade: number;
  data: unknown;
}

export function workerId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * JobAttempt bookkeeping around a processor invocation: a row is created when
 * the job goes active, heartbeated every 15s, and closed with
 * succeeded/failed. Bookkeeping failures never break the job itself.
 */
export async function withJobAttempt<T>(
  ctx: WorkerContext,
  queue: string,
  job: JobLike,
  fn: () => Promise<T>,
): Promise<T> {
  const parsed = tenantPayload.safeParse(job.data);
  if (!parsed.success) {
    throw new Error(`job on queue ${queue} is missing a tenantId payload field`);
  }
  const tenantId = parsed.data.tenantId;
  const jobId = job.id ?? '';

  let attemptId: string | null = null;
  try {
    const created = await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.jobAttempt.create({
        data: {
          tenantId,
          queue,
          jobId,
          dedupKey: jobId,
          attempt: job.attemptsMade + 1,
          status: 'running',
          workerId: workerId(),
        },
        select: { id: true },
      }),
    );
    attemptId = created.id;
  } catch (err) {
    ctx.log.warn({ queue, jobId, err: sanitizeError(err) }, 'job attempt bookkeeping failed');
  }

  let heartbeat: NodeJS.Timeout | null = null;
  if (attemptId !== null) {
    const id = attemptId;
    heartbeat = setInterval(() => {
      void withTenantContext(ctx.prisma, tenantId, (tx) =>
        tx.jobAttempt.update({ where: { id }, data: { heartbeatAt: new Date() } }),
      ).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  }

  const close = async (status: 'succeeded' | 'failed', error: string): Promise<void> => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (attemptId === null) return;
    const id = attemptId;
    await withTenantContext(ctx.prisma, tenantId, (tx) =>
      tx.jobAttempt.update({
        where: { id },
        data: { status, error, finishedAt: new Date() },
      }),
    ).catch(() => undefined);
  };

  try {
    const result = await fn();
    await close('succeeded', '');
    return result;
  } catch (err) {
    await close('failed', sanitizeError(err));
    throw err;
  }
}
