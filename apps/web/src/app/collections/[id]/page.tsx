'use client';
import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart,
  Button,
  Notice,
  PhaseBar,
  ProgressBar,
  Sparkline,
  StatusLive,
  Table,
} from '@aeg-clouddfir/ui';
import type {
  CollectionStatusResponse,
  CollectionThroughputResponse,
} from '@aeg-clouddfir/contracts';
import { ConfirmDialog, QueryBoundary, StatusPill, TruthNotice } from '@/components/shared';
import {
  useCollectionManifest,
  isCollectionActive,
  useCollectionAction,
  useCollectionExceptions,
  useCollectionStatus,
  useCollectionThroughput,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRate,
  humanizeToken,
} from '@/lib/format';

/** Statuses after which the case holds everything the collection got. */
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type CollectionAction = 'pause' | 'resume' | 'cancel' | 'retry';

const ACTION_LABEL: Record<CollectionAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel collection',
  retry: 'Retry failed items',
};

/**
 * Say what an action DID, not that it was requested.
 *
 * "Retry failed items requested." was indistinguishable between a retry that
 * re-queued work and one that matched nothing, which made a working retry look
 * broken.
 */
function describeActionResult(
  action: CollectionAction,
  result: { retriedItems?: number; retriedProcessing?: number },
): string {
  if (action !== 'retry') return `${ACTION_LABEL[action]} requested.`;
  const fetches = result.retriedItems ?? 0;
  const processing = result.retriedProcessing ?? 0;
  if (fetches === 0 && processing === 0) {
    return 'Nothing to retry \u2014 no failed or excepted items remain.';
  }
  const parts: string[] = [];
  if (fetches > 0) parts.push(`${String(fetches)} failed item(s) queued for re-collection`);
  if (processing > 0) parts.push(`${String(processing)} item(s) queued for re-processing`);
  return `Retry started: ${parts.join(' and ')}. Progress updates as the workers pick them up.`;
}

/** Which actions are legal for a status, with a reason when they are not. */
function actionAvailability(
  status: string,
  failures: number,
): Record<CollectionAction, string | null> {
  const active = isCollectionActive(status);
  return {
    pause: active && status !== 'cancelling' ? null : 'Only a running collection can be paused.',
    resume: status === 'paused' ? null : 'Only a paused collection can be resumed.',
    cancel:
      active || status === 'paused'
        ? null
        : 'Only a running or paused collection can be cancelled.',
    retry:
      (status === 'completed' || status === 'failed' || status === 'paused') && failures > 0
        ? null
        : 'Retry is available when a finished or paused collection has failed or excepted items.',
  };
}

export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const status = useCollectionStatus(id);
  const action = useCollectionAction(id);
  const [confirming, setConfirming] = useState<CollectionAction | null>(null);
  const [statusText, setStatusText] = useState('');

  return (
    <>
      <div className="page-header">
        <h1>Collection status</h1>
        <Link href="/collections">All collections</Link>
      </div>
      <QueryBoundary
        isPending={status.isPending}
        error={status.error}
        data={status.data}
        onRetry={() => void status.refetch()}
      >
        {(data) => {
          // Fetch failures AND processing exceptions are both retryable, and
          // they are counted separately: an item whose bytes arrived but whose
          // text could not be extracted has zero fetch failures, so counting
          // only those left the button permanently disabled for exactly the
          // case a user wants to retry.
          const fetchFailures = data.progress.reduce((n, p) => n + p.failures, 0);
          const processingExceptions = Object.values(data.exceptionCounts ?? {}).reduce(
            (n, c) => n + c,
            0,
          );
          const totalFailures = fetchFailures + processingExceptions;
          const availability = actionAvailability(data.status, totalFailures);
          return (
            <>
              <div className="page-header">
                <h2 style={{ margin: 0 }}>{data.name}</h2>
                <StatusPill status={data.status} />
              </div>
              <p>
                Sources: {data.sources.join(', ')} · Started {formatDateTime(data.startedAt)} ·
                Finished {formatDateTime(data.finishedAt)}
                {isCollectionActive(data.status) ? ' · live-updating every 2 s' : ''}
              </p>

              <CompletenessBanner data={data} />

              <div className="button-row" role="group" aria-label="Collection actions">
                {(Object.keys(ACTION_LABEL) as CollectionAction[]).map((a) => {
                  const reason = availability[a];
                  return (
                    <span key={a}>
                      <button
                        type="button"
                        className={
                          a === 'cancel'
                            ? 'cdfir-button cdfir-button--danger'
                            : 'cdfir-button cdfir-button--secondary'
                        }
                        disabled={reason !== null || action.isPending}
                        onClick={() => setConfirming(a)}
                        aria-describedby={reason ? `reason-${a}` : undefined}
                      >
                        {ACTION_LABEL[a]}
                      </button>
                      {reason ? (
                        <span id={`reason-${a}`} className="cdfir-visually-hidden">
                          {reason}
                        </span>
                      ) : null}
                    </span>
                  );
                })}
                {data.manifest?.downloadAvailable ? (
                  <ManifestDownload collectionId={data.id} sha256={data.manifest.sha256} />
                ) : null}
              </div>

              {/* Where the evidence is reviewable. Collecting is only half the
                  job; without this the page says "completed" and gives a
                  reviewer nowhere to go. */}
              {data.case ? (
                <p className="cdfir-collection-case">
                  Filed in case <Link href={`/cases/${data.case.id}`}>{data.case.name}</Link>
                  {FINISHED_STATUSES.has(data.status)
                    ? null
                    : ' — items appear there once the collection finishes.'}
                </p>
              ) : null}

              <StatusLive politeness="polite">{statusText}</StatusLive>

              <h2>Throughput</h2>
              <ThroughputSection collectionId={data.id} />

              <h2>Per-custodian progress</h2>
              <ProgressTable data={data} />

              <h2 id="exceptions-ledger">Exceptions ledger</h2>
              <TruthNotice kind="exceptions" variant="warning" />
              <ExceptionsLedger collectionId={data.id} exceptionCounts={data.exceptionCounts} />

              <ConfirmDialog
                open={confirming !== null}
                title={confirming ? ACTION_LABEL[confirming] : ''}
                body={
                  confirming === 'cancel' ? (
                    <p>
                      Cancelling stops acquisition. Anything already preserved remains preserved and
                      the collection is labeled <strong>cancelled</strong> — never presented as
                      complete.
                    </p>
                  ) : (
                    <p>Confirm: {confirming ? ACTION_LABEL[confirming].toLowerCase() : ''}?</p>
                  )
                }
                confirmLabel={confirming ? ACTION_LABEL[confirming] : 'Confirm'}
                destructive={confirming === 'cancel'}
                busy={action.isPending}
                onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  if (!confirming) return;
                  action.mutate(confirming, {
                    onSuccess: (result) => {
                      setStatusText(describeActionResult(confirming, result));
                      setConfirming(null);
                    },
                    onError: (err) => {
                      setStatusText(errorMessage(err));
                      setConfirming(null);
                    },
                  });
                }}
              />
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

function CompletenessBanner({ data }: { data: CollectionStatusResponse }) {
  if (!data.completeness) {
    return (
      <Notice variant="info">
        Completeness is determined when the collection finishes; until then this collection is{' '}
        <strong>in progress</strong>.
      </Notice>
    );
  }
  const variant = data.completeness === 'complete_within_selected_api_scope' ? 'info' : 'warning';
  return (
    <Notice variant={variant} title={humanizeToken(data.completeness)}>
      {data.completenessNarrative ??
        'See the exception ledger and manifest for the full account of what was and was not acquired.'}
    </Notice>
  );
}

/** States whose transition is worth interrupting a screen-reader user for. */
const ANNOUNCED_STATES = new Set(['stalled', 'rate_limited', 'processing', 'finished']);

/**
 * What a state means, in a sentence. The word and the icon carry the meaning;
 * the colour only reinforces it, because colour is never the only signal here.
 */
const STATE_ICON: Record<string, string> = {
  measuring: '\u25cc',
  discovering: '\u25cc',
  fetching: '\u25b6',
  processing: '\u27f3',
  slow: '\u25bc',
  rate_limited: '\u23f8',
  stalled: '\u26a0',
  finished: '\u2713',
};

const STATE_EXPLANATION: Record<string, string> = {
  measuring: 'Too little has happened yet to state a pace. Counts are exact.',
  discovering:
    'Still listing what exists at the provider, so the total can still grow. No percentage is shown, because a fraction of an unknown total would be wrong.',
  fetching: 'Acquiring from the provider at a normal pace for this run.',
  processing:
    'Every byte has arrived. The remaining work is reading the items \u2014 parse, text extraction, OCR and indexing. On the largest collection so far this phase was 27 of 93 hours.',
  slow: 'Still moving, but slower than this run\u2019s own typical minute.',
  rate_limited: 'The provider asked us to wait. Nothing is wrong; acquisition resumes on its own.',
  stalled:
    'Nothing has been acquired for 15 minutes while work is still in flight. The worker\u2019s recovery sweep re-drives items at this same threshold.',
  finished: 'This collection has stopped. See completeness and the exception ledger.',
};

/**
 * Measured throughput, in two phases.
 *
 * Deliberately shows no finish time, no countdown and no "about N hours left".
 * Replaying the biggest real run, a 5-minute window predicted the remainder
 * between -16% and +33% of the truth and a 30-minute window between -25% and
 * +68%; a low/high band still missed at 4 of 9 checkpoints. So: elapsed time,
 * measured pace, counts and size.
 *
 * The live region announces PHASE changes and a stall, and nothing else. Pace
 * numbers refresh every 5 seconds, and a polite live region firing that often
 * makes the whole page unusable with a screen reader.
 */
function ThroughputSection({ collectionId }: { collectionId: string }) {
  // Named `range`, not `window`: shadowing the global would be a trap for the
  // next person reading this file.
  const [range, setRange] = useState<'live' | 'history'>('live');
  const throughput = useCollectionThroughput(collectionId, range);
  const [announcement, setAnnouncement] = useState('');
  const lastState = useRef<string | null>(null);

  const state = throughput.data?.state;
  const stateLabel = throughput.data?.stateLabel;
  useEffect(() => {
    if (state === undefined || stateLabel === undefined) return;
    if (lastState.current === state) return;
    const previous = lastState.current;
    lastState.current = state;
    // Only the transitions that change what someone should do. Never the pace.
    if (previous !== null && ANNOUNCED_STATES.has(state)) {
      setAnnouncement(`${stateLabel}. ${STATE_EXPLANATION[state] ?? ''}`);
    }
  }, [state, stateLabel]);

  return (
    <>
      <div className="button-row" role="group" aria-label="Throughput window">
        <button
          type="button"
          className="cdfir-button cdfir-button--secondary"
          aria-pressed={range === 'live'}
          onClick={() => setRange('live')}
        >
          Last 60 minutes
        </button>
        <button
          type="button"
          className="cdfir-button cdfir-button--secondary"
          aria-pressed={range === 'history'}
          onClick={() => setRange('history')}
        >
          Whole run
        </button>
      </div>
      {/* Phase and stall transitions only. Pace must never reach this region. */}
      <StatusLive politeness="polite">{announcement}</StatusLive>
      <QueryBoundary
        isPending={throughput.isPending}
        error={throughput.error}
        data={throughput.data}
        onRetry={() => void throughput.refetch()}
      >
        {(t) => (
          <>
            <p>
              <span
                className={`cdfir-throughput-state cdfir-throughput-state--${t.health}`}
                // The icon is decorative; the word beside it is the signal.
                aria-label={`State: ${t.stateLabel}`}
              >
                <span aria-hidden="true">{STATE_ICON[t.state] ?? '\u25cf'}</span>
                {t.stateLabel}
              </span>{' '}
              {STATE_EXPLANATION[t.state] ?? ''}
            </p>
            {t.exceptionCount > 0 ? (
              <Notice variant="warning" title="This collection has exceptions">
                {t.exceptionCount} item(s) could not be acquired or read. A collection with
                exceptions is never reported as clean &mdash; see the{' '}
                <a href="#exceptions-ledger">exception ledger</a> below for what is missing.
              </Notice>
            ) : null}

            {/* Headline figures as text, above every chart. No estimate anywhere. */}
            <div className="cdfir-throughput-phases">
              <PhaseFigures
                title="Acquisition"
                detail="Bytes arriving from the provider."
                phase={t.acquisition}
              />
              <PhaseFigures
                title="Processing tail"
                detail="Parse, text extraction, OCR and indexing, after the last byte arrived."
                phase={t.processing}
              />
            </div>

            <PhaseBar
              counts={t.itemStates}
              caption={`Where all ${t.totals.items} items are right now`}
            />

            <Sparkline
              windowName={t.windowName}
              bucketMinutes={t.bucketMinutes}
              buckets={t.buckets}
              pace={t.acquisition.pace}
              totals={{
                items: t.totals.items,
                bytes: t.totals.bytes,
                idleBuckets: t.totals.idleBuckets,
              }}
            />

            <AreaChart windowName={t.windowName} buckets={t.buckets} />

            <p className="cdfir-field__hint">
              Provider wait so far: {formatDuration(t.rateLimitWaitMs)}. Measured from{' '}
              {formatDateTime(t.totals.firstAcquiredAt)} to{' '}
              {formatDateTime(t.totals.lastAcquiredAt)}. No finish time is shown: on the largest
              collection so far, predicting one from a 5-minute window was wrong by -16% to +33%.
            </p>
          </>
        )}
      </QueryBoundary>
    </>
  );
}

/** One phase's figures, as plain text. Readable with stylesheets switched off. */
function PhaseFigures({
  title,
  detail,
  phase,
}: {
  title: string;
  detail: string;
  phase: CollectionThroughputResponse['acquisition'];
}) {
  return (
    <div>
      <h3>{title}</h3>
      <p className="cdfir-field__hint">{detail}</p>
      <ul className="cdfir-count-list">
        <li>
          <span>Items settled</span>
          <span>
            {phase.done}
            {phase.total === null ? ' of a total still being discovered' : ` of ${phase.total}`}
          </span>
        </li>
        <li>
          <span>Share done</span>
          {/* No percentage while the denominator moves: this run's own total went
              from 185,379 provider items to 434,910 evidence items. */}
          <span>
            {phase.percent === null ? 'not yet knowable' : `${phase.percent.toFixed(1)}%`}
          </span>
        </li>
        <li>
          <span>Still working</span>
          <span>{phase.inFlight}</span>
        </li>
        <li>
          <span>Elapsed</span>
          <span>{formatDuration(phase.elapsedMs)}</span>
        </li>
        <li>
          <span>Measured pace</span>
          <span>{formatRate(phase.pace.itemsPerMinute, 'items')}</span>
        </li>
      </ul>
    </div>
  );
}

function ProgressTable({ data }: { data: CollectionStatusResponse }) {
  if (data.progress.length === 0) return <p>No per-custodian progress reported yet.</p>;
  return (
    <Table caption="Per-custodian, per-source progress" captionHidden>
      <thead>
        <tr>
          <th scope="col">Custodian</th>
          <th scope="col">Source</th>
          <th scope="col">Fetched / discovered</th>
          <th scope="col">Preserved</th>
          <th scope="col">Parsed</th>
          <th scope="col">OCR</th>
          <th scope="col">Indexed</th>
          <th scope="col">Warnings</th>
          <th scope="col">Failures</th>
          <th scope="col">Retries</th>
          <th scope="col">Rate-limit wait</th>
          <th scope="col">Checkpoint</th>
        </tr>
      </thead>
      <tbody>
        {data.progress.map((p) => (
          <tr key={`${p.custodianId}-${p.source}`}>
            <td>{p.custodianEmail}</td>
            <td>{p.source}</td>
            <td>
              <ProgressBar
                label={`${p.custodianEmail} ${p.source}: fetched of discovered`}
                value={p.fetched}
                max={p.discovered}
              />
            </td>
            <td>{p.preserved}</td>
            <td>{p.parsed}</td>
            <td>{p.ocrExtracted}</td>
            <td>{p.indexed}</td>
            <td>{p.warnings}</td>
            <td>{p.failures}</td>
            <td>{p.retries}</td>
            <td>{(p.rateLimitWaitMs / 1000).toFixed(1)} s</td>
            <td className="mono">{p.checkpoint ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ExceptionsLedger({
  collectionId,
  exceptionCounts,
}: {
  collectionId: string;
  exceptionCounts: Record<string, number>;
}) {
  const kinds = Object.keys(exceptionCounts).sort();
  const [kindFilter, setKindFilter] = useState('');
  const exceptions = useCollectionExceptions(collectionId, kindFilter);

  if (kinds.length === 0) return <p>No exceptions recorded.</p>;

  return (
    <>
      <div className="button-row">
        <label>
          Filter by kind{' '}
          <select
            className="cdfir-select"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
          >
            <option value="">
              All kinds ({kinds.reduce((n, k) => n + (exceptionCounts[k] ?? 0), 0)})
            </option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {humanizeToken(k)} ({exceptionCounts[k]})
              </option>
            ))}
          </select>
        </label>
      </div>
      <QueryBoundary
        isPending={exceptions.isPending}
        error={exceptions.error}
        data={exceptions.data}
        onRetry={() => void exceptions.refetch()}
      >
        {(page) =>
          page.items.length === 0 ? (
            <p>No exceptions match this filter.</p>
          ) : (
            <Table caption="Exception ledger entries" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Message</th>
                  <th scope="col">Item</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((e) => (
                  <tr key={e.id}>
                    <td>{humanizeToken(e.kind)}</td>
                    <td>{e.message}</td>
                    <td className="mono">
                      {e.itemRef ?? '\u2014'}
                      {e.mimeType ? (
                        <span className="cdfir-field__hint">
                          {` ${e.mimeType}${e.sizeBytes !== null ? ` \u00b7 ${formatBytes(e.sizeBytes)}` : ''}`}
                        </span>
                      ) : null}
                    </td>
                    <td>{formatDateTime(e.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
    </>
  );
}

/**
 * Resolves the collection's manifest URLs on demand.
 *
 * The endpoint returns presigned URLs rather than the file itself, so a plain
 * link would render JSON in the browser. The manifest sha256 is shown in full
 * because it is the value a recipient checks the downloaded bytes against.
 */
function ManifestDownload({ collectionId, sha256 }: { collectionId: string; sha256: string }) {
  const manifest = useCollectionManifest();
  const links = manifest.data;

  if (links) {
    return (
      <div className="cdfir-downloads">
        <a href={links.manifestUrl}>Download manifest</a>
        {links.completenessReportUrl ? (
          <a href={links.completenessReportUrl}>Download completeness report</a>
        ) : null}
        <span className="cdfir-field__hint">manifest sha256:</span>
        <span className="cdfir-downloads__hash">{links.manifestSha256}</span>
      </div>
    );
  }

  return (
    <div className="cdfir-downloads">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          manifest.mutate(collectionId);
        }}
        disabled={manifest.isPending}
      >
        {manifest.isPending
          ? 'Preparing\u2026'
          : `Download manifest (sha256 ${sha256.slice(0, 12)}\u2026)`}
      </Button>
      {manifest.isError ? (
        <span className="cdfir-field__error">{errorMessage(manifest.error)}</span>
      ) : null}
    </div>
  );
}
