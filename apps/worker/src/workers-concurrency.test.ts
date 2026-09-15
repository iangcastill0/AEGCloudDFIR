import { describe, expect, it } from 'vitest';
import { CPU_BOUND_QUEUES, queueConcurrency } from './workers.js';
import { ALL_QUEUE_NAMES, QUEUES } from './queues.js';

describe('queueConcurrency', () => {
  /**
   * Concurrency used to be a hardcoded 4 for every CPU-bound stage, which made
   * the worker's throughput independent of the machine under it. A five-core
   * host sat at load 27 with 218,746 extractions and 26,957 OCR jobs queued,
   * and moving to a 32-core host would have run the same four at a time.
   */
  it('scales every CPU-bound stage with the setting', () => {
    const c = queueConcurrency(12);
    for (const queue of CPU_BOUND_QUEUES) {
      expect(c[queue]).toBe(12);
    }
  });

  it('leaves provider fetches alone however big the machine is', () => {
    // These are bounded by Microsoft and Google rate limits, not by cores.
    // Raising them buys 429s, not throughput — and a throttled connector
    // stalls a collection for everyone on that tenant.
    const small = queueConcurrency(4);
    const huge = queueConcurrency(64);

    for (const queue of [
      QUEUES.collectionDiscover,
      QUEUES.collectionFetchPage,
      QUEUES.collectionFetchItem,
    ]) {
      expect(huge[queue]).toBe(small[queue]);
    }
  });

  it('keeps run-level stages serial', () => {
    // An export, a production and a deletion each produce one coherent
    // artifact. Two at once on the same run would interleave into nonsense.
    const c = queueConcurrency(32);
    expect(c[QUEUES.exportRun]).toBe(1);
    expect(c[QUEUES.productionRun]).toBe(1);
    expect(c[QUEUES.deletionRun]).toBe(1);
  });

  it('keeps container extraction at one', () => {
    // pstExtract writes a temp copy of an entire container to disk. That is a
    // memory and disk decision, not a CPU one.
    expect(queueConcurrency(32)[QUEUES.pstExtract]).toBe(1);
  });

  it('does not scale virus scanning past clamd', () => {
    // Bounded by clamd's own MaxThreads. Sending more just queues inside
    // ClamAV instead of here, where at least it is visible.
    expect(queueConcurrency(32)[QUEUES.processScan]).toBe(queueConcurrency(4)[QUEUES.processScan]);
  });

  it('covers every queue, so a new one cannot start with undefined', () => {
    // BullMQ reads concurrency as a number; undefined would silently become
    // its default of 1 and quietly serialize a stage nobody meant to serialize.
    const c = queueConcurrency(4);
    for (const queue of ALL_QUEUE_NAMES) {
      expect(typeof c[queue]).toBe('number');
      expect(c[queue]).toBeGreaterThanOrEqual(1);
    }
  });

  it('matches the old hardcoded values at the default setting', () => {
    // The default must change nothing. An operator who does not set the
    // variable should get exactly the behaviour they had before.
    const c = queueConcurrency(4);
    expect(c).toEqual({
      [QUEUES.collectionDiscover]: 2,
      [QUEUES.collectionFetchPage]: 2,
      [QUEUES.collectionFetchItem]: 8,
      [QUEUES.collectionFinalize]: 2,
      [QUEUES.pstExtract]: 1,
      [QUEUES.processParse]: 4,
      [QUEUES.processExtract]: 4,
      [QUEUES.processOcr]: 4,
      [QUEUES.processPreview]: 4,
      [QUEUES.processScan]: 4,
      [QUEUES.searchIndex]: 8,
      [QUEUES.searchCaseCollection]: 2,
      [QUEUES.exportRun]: 1,
      [QUEUES.productionRun]: 1,
      [QUEUES.deletionRun]: 1,
      [QUEUES.deadLetter]: 2,
    });
  });
});
