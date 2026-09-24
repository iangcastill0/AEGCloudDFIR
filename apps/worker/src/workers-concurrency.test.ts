import { describe, expect, it } from 'vitest';
import { CPU_BOUND_QUEUES, OCR_QUEUES, queueConcurrency } from './workers.js';
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
      // The OCR lanes are the exception: they SHARE the budget rather than
      // each taking it, so they are asserted together below.
      if (OCR_QUEUES.includes(queue)) continue;
      expect(c[queue]).toBe(12);
    }
  });

  /**
   * Splitting process.ocr into a document lane and an image lane must not
   * double the OCR load on the host. The production box was already at load
   * 17.87 on 8 cores, with the worker at 376% CPU and Tika at 314%, and an
   * export crawling on what was left.
   */
  it('shares ONE budget across both OCR lanes rather than one each', () => {
    for (const budget of [2, 4, 8, 32]) {
      const c = queueConcurrency(budget);
      const total = OCR_QUEUES.reduce((sum, q) => sum + c[q], 0);
      expect(total).toBe(budget);
    }
  });

  /**
   * Image OCR is the high-volume, low-yield class: measured on the production
   * corpus, 96.0% of 7,496 image OCRs returned less than 40 characters and the
   * best single result was 468. It must make progress in the background and
   * must never be able to starve anything, however large the machine.
   */
  it('pins image OCR at one lane on every machine size', () => {
    for (const budget of [1, 4, 64]) {
      expect(queueConcurrency(budget)[QUEUES.processOcrImage]).toBe(1);
    }
  });

  it('never starves document OCR, even at the smallest budget', () => {
    // Math.max(1, ...) matters: budget 1 must still leave the PDF lane able to
    // run, or the valuable class stops entirely.
    expect(queueConcurrency(1)[QUEUES.processOcr]).toBeGreaterThanOrEqual(1);
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

  it('pins the whole table at the default setting', () => {
    // Everything outside OCR is unchanged from before the split. OCR is now
    // 3 + 1 where it used to be a single 4, so total OCR parallelism on the
    // host is identical — the split bought isolation, not more load.
    const c = queueConcurrency(4);
    expect(c).toEqual({
      [QUEUES.collectionDiscover]: 2,
      [QUEUES.collectionFetchPage]: 2,
      [QUEUES.collectionFetchItem]: 8,
      [QUEUES.collectionFinalize]: 2,
      [QUEUES.pstExtract]: 1,
      [QUEUES.importAnalyze]: 1,
      [QUEUES.processParse]: 4,
      [QUEUES.processExtract]: 4,
      [QUEUES.processOcr]: 3,
      [QUEUES.processOcrImage]: 1,
      [QUEUES.processPreview]: 4,
      [QUEUES.processScan]: 4,
      [QUEUES.searchIndex]: 8,
      [QUEUES.searchCaseCollection]: 2,
      [QUEUES.searchCaseImport]: 2,
      [QUEUES.exportRun]: 1,
      [QUEUES.productionRun]: 1,
      [QUEUES.deletionRun]: 1,
      [QUEUES.deadLetter]: 2,
    });
  });
});
