import type { PrismaClient } from '@evidencevault/database';

export interface OutboxRow {
  id: string;
  tenantId: string;
  topic: string;
  dedupKey: string;
  payload: unknown;
  attempts: number;
}

export interface JobEnqueuer {
  /** Enqueue on queue `topic` with BullMQ jobId = dedupKey (idempotent). */
  enqueue(topic: string, dedupKey: string, payload: unknown): Promise<void>;
}

export interface DispatcherLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface DispatcherOptions {
  batchSize?: number;
  idleDelayMs?: number;
  errorDelayMs?: number;
  maxAttempts?: number;
}

/**
 * Transactional-outbox dispatcher (ADR-004).
 *
 * Producers write OutboxEvent rows atomically with their state changes. This
 * loop claims pending rows with FOR UPDATE SKIP LOCKED (safe under multiple
 * dispatcher replicas), enqueues BullMQ jobs whose jobId is the deterministic
 * dedup key, and marks rows dispatched in the same transaction that claimed
 * them. A crash after enqueue but before commit re-delivers the same jobId,
 * which BullMQ collapses — at-least-once dispatch, exactly-once effect given
 * idempotent consumers.
 *
 * RLS note: outbox_events is readable across tenants only when
 * app.worker = 'true' (see migration 20260807000002); each claim transaction
 * sets that flag locally.
 */
export class OutboxDispatcher {
  private running = false;
  private readonly batchSize: number;
  private readonly idleDelayMs: number;
  private readonly errorDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly enqueuer: JobEnqueuer,
    private readonly log: DispatcherLogger,
    options: DispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.idleDelayMs = options.idleDelayMs ?? 500;
    this.errorDelayMs = options.errorDelayMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 10;
  }

  /** Claim and dispatch one batch. Returns number of rows handled. */
  async dispatchOnce(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.worker', 'true', true)`;
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, "tenantId", topic, "dedupKey", payload, attempts
        FROM outbox_events
        WHERE status = 'pending'
        ORDER BY "createdAt"
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED`;

      if (rows.length === 0) return 0;

      const dispatched: string[] = [];
      for (const row of rows) {
        try {
          await this.enqueuer.enqueue(row.topic, row.dedupKey, {
            tenantId: row.tenantId,
            outboxEventId: row.id,
            ...(typeof row.payload === 'object' && row.payload !== null ? row.payload : {}),
          });
          dispatched.push(row.id);
        } catch (err) {
          const attempts = row.attempts + 1;
          const failed = attempts >= this.maxAttempts;
          await tx.$executeRaw`
            UPDATE outbox_events
            SET attempts = ${attempts},
                "lastError" = ${err instanceof Error ? err.message : String(err)},
                status = ${failed ? 'failed' : 'pending'}::"OutboxStatus"
            WHERE id = ${row.id}::uuid`;
          this.log.warn(
            { outboxEventId: row.id, topic: row.topic, attempts, failed },
            'outbox enqueue failed',
          );
        }
      }

      if (dispatched.length > 0) {
        await tx.$executeRaw`
          UPDATE outbox_events
          SET status = 'dispatched'::"OutboxStatus", "dispatchedAt" = now()
          WHERE id = ANY(${dispatched}::uuid[])`;
      }
      return rows.length;
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    this.log.info({}, 'outbox dispatcher started');
    while (!signal.aborted) {
      let handled = 0;
      try {
        handled = await this.dispatchOnce();
      } catch (err) {
        this.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'outbox dispatch cycle failed',
        );
        await sleep(this.errorDelayMs, signal);
        continue;
      }
      if (handled === 0) await sleep(this.idleDelayMs, signal);
    }
    this.running = false;
    this.log.info({}, 'outbox dispatcher stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
