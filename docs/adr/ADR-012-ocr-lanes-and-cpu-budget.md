# ADR-012: Two OCR lanes, one CPU budget, and a page cap that admits itself

Status: proposed · Date: 2026-09-21

## Context

A 434,910-item native export on production crawled at 1.84 MB/s while the host
sat at load 17.87 on 8 cores. The export was not the problem. It was starved by
an OCR backlog, and measuring that backlog turned up three separate faults.

All numbers below were measured on the production host (`cdfir-prod`) on
2026-09-21. They are recorded here because the conclusions are not what the
shapes of the queues suggest.

**The backlog is real work, not a retry storm.** 135,629 queued OCR jobs
against 234 lifetime failures.

**Individual image OCR jobs are fast; the queue is not.** Sampled completed
jobs ran 0.3-8.4 seconds, mostly under a second. Yet measured throughput across
100 consecutive completions was **2.26 jobs/minute**. For comparison,
`process.extract` measured 34 jobs/minute over the same kind of window.

The gap is head-of-line blocking. One FIFO queue held two cost classes. When
sampled, both OCR slots were occupied by PDFs — `Aging Report.pdf` (2.7 MB) had
been running **33 minutes** — while roughly 90,000 sub-second image jobs waited
behind them. At 2.26/min the backlog is about 41 days, and it grows, because
finishing an extraction is what enqueues the OCR behind it.

**The two classes are worth wildly different amounts.** Yield, measured from
`extracted_texts.charCount` against `LOW_TEXT_THRESHOLD` (40):

| Class  | OCRed | Under 40 chars | Best single result |
| ------ | ----- | -------------- | ------------------ |
| PDFs   | 479   | **1.3%**       | 828,986 chars      |
| Images | 7,496 | **96.0%**      | 468 chars          |

**Size does not predict image yield**, which is the finding that killed the
obvious fix. Bucketed by source size, the proportion returning under 40
characters was 95.8% (<20 KB), 94.5% (20-50 KB), 91.6% (50-100 KB), 93.4%
(100-500 KB) and **98.7% (>500 KB)**. The largest images were the worst. A size
floor would have been arbitrary and ineffective.

For context on where the volume comes from: of 90,328 pending image OCR jobs,
89,043 are `inline_attachment` — images embedded in email bodies, which is what
signature logos, banners and icons are.

## Decision

### 1. Split `process.ocr` into two queues

`process.ocr` keeps PDFs and converted documents. A new `process.ocr.image`
takes direct image OCR. The processor is the same on both sides; only the
scheduling differs.

Per-queue concurrency is the only mechanism available here that **caps** a
class's share of the machine. BullMQ priority was rejected: it reorders what is
waiting, but it cannot preempt the 33-minute job already running, and it does
not stop 90,000 low-priority jobs from eventually consuming every slot.

The dedup key stays `ocr:<id>:v<n>` on both lanes. An item is one piece of work
whichever queue runs it, and a lane-specific key would let the same item be
OCRed twice the first time the routing rule changed.

### 2. The two lanes share one budget

`processOcr` gets `cpuConcurrency - 1` and `processOcrImage` gets exactly 1, so
the pair always sums to `CDFIR_WORKER_CPU_CONCURRENCY`. Splitting the queue must
not double the OCR load on a host that is already oversubscribed.

Image OCR is pinned at one lane on every machine size. It is the high-volume,
low-yield class; its job is to make progress in the background and never to be
able to starve anything.

### 3. The page cap drops to 500, and a truncated read says so

`CDFIR_MAX_OCR_PAGES` goes from 2000 to 500. The number is not arbitrary:
`MAX_OCR_PAGES_INDEXED` in `search-index.ts` is already 500, so pages past that
were rasterised, OCRed, and then discarded before reaching the index.

More importantly, hitting the cap is now reported. `process-ocr.ts` rasterises
one page **past** the cap purely to learn whether a page past the cap exists,
then records the stopping point in `evidence_items.processingDetail`, in a
collection exception, and in the audit event.

This is the part that matters for the product's core promise. Before this
change `processingDetail` was empty for all 395 completed OCR items, so an item
read in part was indistinguishable from one read in full.

### 4. Image OCR is kept, not gated

The measurements make a strong case for switching image OCR off, and it is
rejected. 298 of 7,496 image OCRs did clear the threshold, and 201 of those are
named like camera photos or screenshots. A screenshot of a conversation is
evidence. Dropping it silently is exactly the failure this product exists to
avoid.

Image OCR goes in the slow lane instead. If it is ever skipped, that must be a
recorded per-item decision, not an invisible policy.

## Consequences

Work already queued stays on the old queue name, so the split only routes what
is enqueued after it. `apps/worker/src/requeue-ocr-by-class.ts` moves waiting
image jobs across; it is dry-run by default, preserves the BullMQ job id so a
second run
cannot duplicate, and adds before removing so an interruption leaves a duplicate
rather than a hole. Not running it loses nothing — both queues have workers, the
lanes just keep blocking each other.

`queueConcurrency` no longer returns the same number for every CPU-bound stage,
so `CPU_BOUND_QUEUES` alone no longer describes the table. `OCR_QUEUES` names
the pair that shares a budget, and the tests assert the sum rather than the
members.

Lowering the page cap means some long documents that were fully OCRed before
will now be read in part. That is a deliberate trade — an unbounded single job
was starving 135,000 others — and it is visible rather than silent. Anything
already OCRed keeps the text it has; the cap applies to new work.

None of this takes effect without restarting the worker, which abandons any
export in flight: `processExportRun` only short-circuits on `ready`, `failed`
and `cancelled`, so a `running` export restarts from its first item.

The CPU budget is scoped to the OCR lanes because that is where the cost was
measured. `parse`, `extract` and `preview` keep per-stage concurrency —
extraction is bound by Tika in a separate container rather than by local CPU,
and the other two have not been measured here. Widening the budget to cover them
needs its own numbers first.
