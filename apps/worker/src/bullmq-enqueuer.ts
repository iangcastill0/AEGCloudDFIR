import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobEnqueuer } from './outbox/dispatcher.js';
import { ALL_QUEUE_NAMES, DEFAULT_JOB_OPTIONS, type QueueName } from './queues.js';

/**
 * BullMQ-backed enqueuer. jobId = dedup key: adding the same logical job
 * twice while one is pending/active is a no-op, which makes outbox
 * redelivery safe.
 */
export class BullMqEnqueuer implements JobEnqueuer {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly connection: Redis) {}

  private queueFor(topic: string): Queue {
    if (!ALL_QUEUE_NAMES.includes(topic as QueueName)) {
      throw new Error(`unknown queue topic '${topic}'`);
    }
    let queue = this.queues.get(topic);
    if (!queue) {
      queue = new Queue(topic, {
        connection: this.connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(topic, queue);
    }
    return queue;
  }

  async enqueue(topic: string, dedupKey: string, payload: unknown): Promise<void> {
    await this.queueFor(topic).add(topic, payload, { jobId: sanitizeJobId(dedupKey) });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

/** BullMQ jobIds must not contain ':' delimiter problems? They may, but must not be empty or huge. */
export function sanitizeJobId(dedupKey: string): string {
  if (!dedupKey || dedupKey.length > 512) {
    throw new Error('dedup key must be 1..512 chars');
  }
  return dedupKey;
}
