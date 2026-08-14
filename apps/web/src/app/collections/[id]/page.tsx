'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { Button, Notice, ProgressBar, StatusLive, Table } from '@aeg-clouddfir/ui';
import type { CollectionStatusResponse } from '@aeg-clouddfir/contracts';
import { ConfirmDialog, QueryBoundary, StatusPill, TruthNotice } from '@/components/shared';
import {
  useCollectionManifest,
  isCollectionActive,
  useCollectionAction,
  useCollectionExceptions,
  useCollectionStatus,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDateTime, humanizeToken } from '@/lib/format';

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

              <StatusLive politeness="polite">{statusText}</StatusLive>

              <h2>Per-custodian progress</h2>
              <ProgressTable data={data} />

              <h2>Exceptions ledger</h2>
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
