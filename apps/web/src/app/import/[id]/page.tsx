'use client';
import { use, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, EmptyState, Notice, StatusLive } from '@aeg-clouddfir/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { CrushPreview, SafeEvidencePreview } from '@/components/ImportPreview';
import {
  useAttachImport,
  useCases,
  useEvidencePreview,
  useImportArtifact,
  useImportArtifacts,
  useImportDetail,
  useMe,
  useRetryImport,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDateTime } from '@/lib/format';

export default function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useImportDetail(id);
  const artifactsQuery = useImportArtifacts(id);
  const artifacts = useMemo(
    () =>
      (artifactsQuery.data?.pages.flatMap((page) => page.items) ?? []).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    [artifactsQuery.data],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useImportArtifact(id, activeId);
  const preview = useEvidencePreview(active.data?.evidenceItemId ?? null);
  const retry = useRetryImport();
  const attach = useAttachImport();
  const cases = useCases();
  const me = useMe();
  const [caseId, setCaseId] = useState('');
  const [status, setStatus] = useState('');
  const canManage =
    me.data?.roles.some((role) => role === 'org_admin' || role === 'case_manager') ?? false;
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: artifacts.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 42,
    overscan: 10,
  });

  async function retryImport() {
    try {
      await retry.mutateAsync(id);
      setStatus('Analysis retry queued.');
    } catch (err) {
      setStatus(`Retry failed: ${errorMessage(err)}`);
    }
  }

  async function attachToCase() {
    if (!caseId) return;
    try {
      const result = await attach.mutateAsync({ importId: id, caseId });
      setStatus(`${result.itemsAdded} item(s) added to the case.`);
    } catch (err) {
      setStatus(`Case attachment failed: ${errorMessage(err)}`);
    }
  }

  return (
    <>
      <p>
        <Link href="/import">← All imports</Link>
      </p>
      <StatusLive politeness="polite">{status}</StatusLive>
      <QueryBoundary
        isPending={detail.isPending}
        error={detail.error}
        data={detail.data}
        onRetry={() => void detail.refetch()}
      >
        {(item) => (
          <>
            <div className="page-header">
              <div>
                <h1>{item.name}</h1>
                <p>
                  <StatusPill status={item.status} /> {item.artifactCount} item(s) · uploaded{' '}
                  {formatDateTime(item.createdAt)}
                </p>
              </div>
              {item.status === 'failed' && canManage ? (
                <Button onClick={() => void retryImport()} disabled={retry.isPending}>
                  Retry analysis
                </Button>
              ) : null}
            </div>
            {item.error ? <Notice variant="warning">{item.error}</Notice> : null}
            {canManage ? (
              <section aria-labelledby="attach-heading">
                <h2 id="attach-heading">Cases</h2>
                <div className="cdfir-field-row">
                  <label>
                    Attach this import
                    <select
                      className="cdfir-select"
                      value={caseId}
                      onChange={(event) => setCaseId(event.target.value)}
                    >
                      <option value="">Choose a case…</option>
                      {(cases.data?.items ?? []).map((caseItem) => (
                        <option key={caseItem.id} value={caseItem.id}>
                          {caseItem.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    onClick={() => void attachToCase()}
                    disabled={!caseId || attach.isPending || item.caseIds.includes(caseId)}
                  >
                    {item.caseIds.includes(caseId) ? 'Already attached' : 'Attach'}
                  </Button>
                </div>
              </section>
            ) : null}
          </>
        )}
      </QueryBoundary>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(18rem, 34%) minmax(0, 1fr)',
          gap: '1rem',
          marginTop: '1rem',
        }}
      >
        <section aria-labelledby="tree-heading">
          <h2 id="tree-heading">File tree</h2>
          <QueryBoundary
            isPending={artifactsQuery.isPending}
            error={artifactsQuery.error}
            data={artifactsQuery.data}
            onRetry={() => void artifactsQuery.refetch()}
          >
            {() =>
              artifacts.length === 0 ? (
                <EmptyState
                  title="No parsed items yet"
                  description="The list fills as analysis finishes."
                />
              ) : (
                <>
                  <div
                    ref={listRef}
                    role="listbox"
                    aria-label="Imported files"
                    style={{ height: '32rem', overflow: 'auto', border: '1px solid var(--border)' }}
                  >
                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                      {virtualizer.getVirtualItems().map((virtualRow) => {
                        const artifact = artifacts[virtualRow.index]!;
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            role="option"
                            aria-selected={activeId === artifact.id}
                            onClick={() => setActiveId(artifact.id)}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: virtualRow.size,
                              transform: `translateY(${virtualRow.start}px)`,
                              textAlign: 'left',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              paddingLeft: `${String(0.75 + artifact.path.split('/').length * 0.75)}rem`,
                            }}
                          >
                            <span aria-hidden="true">
                              {artifact.kind === 'directory' ? '▸ ' : '• '}
                            </span>
                            {artifact.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {artifactsQuery.hasNextPage ? (
                    <Button
                      onClick={() => void artifactsQuery.fetchNextPage()}
                      disabled={artifactsQuery.isFetchingNextPage}
                    >
                      Load more
                    </Button>
                  ) : null}
                </>
              )
            }
          </QueryBoundary>
        </section>

        <section aria-labelledby="viewer-heading">
          <h2 id="viewer-heading">Viewer</h2>
          {activeId === null ? (
            <EmptyState title="Choose a file" description="Select an item from the file tree." />
          ) : (
            <QueryBoundary
              isPending={active.isPending}
              error={active.error}
              data={active.data}
              onRetry={() => void active.refetch()}
            >
              {(artifact) => (
                <>
                  <h3>{artifact.name}</h3>
                  <p>
                    {artifact.mimeType || 'Unknown type'} · {formatBytes(artifact.size)}
                  </p>
                  <dl>
                    {Object.entries(artifact.metadata).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <CrushPreview viewerType={artifact.viewerType} value={artifact.preview} />
                  <SafeEvidencePreview preview={preview.data} />
                </>
              )}
            </QueryBoundary>
          )}
        </section>
      </div>
    </>
  );
}
