'use client';
import { use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, Table } from '@evidencevault/ui';
import { QueryBoundary, StatusPill, TruthNotice } from '@/components/shared';
import { useProduction, useProductionExceptions } from '@/lib/hooks';
import { apiDownloadUrl } from '@/lib/api';
import { formatBates } from '@/lib/production-wizard';
import { humanizeToken } from '@/lib/format';

export default function ProductionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const production = useProduction(id);
  const exceptions = useProductionExceptions(id);
  const router = useRouter();

  return (
    <>
      <div className="page-header">
        <h1>Production</h1>
        <Link href="/productions">All productions</Link>
      </div>
      <QueryBoundary
        isPending={production.isPending}
        error={production.error}
        data={production.data}
        onRetry={() => void production.refetch()}
      >
        {(data) => (
          <>
            <div className="page-header">
              <h2 style={{ margin: 0 }}>{data.name}</h2>
              <Button
                variant="secondary"
                onClick={() => {
                  // Clone settings into a new wizard run via sessionStorage handoff.
                  window.sessionStorage.setItem(
                    'ev-production-clone-v1',
                    JSON.stringify(data.parameters),
                  );
                  router.push('/productions/new');
                }}
              >
                Clone settings into a new production
              </Button>
            </div>
            {data.description ? <p>{data.description}</p> : null}

            <h2>Parameter summary</h2>
            <Table caption="Production parameters" captionHidden>
              <tbody>
                <tr>
                  <th scope="row">Output</th>
                  <td>{humanizeToken(data.parameters.output.mode)}</td>
                </tr>
                <tr>
                  <th scope="row">Sort</th>
                  <td>{humanizeToken(data.parameters.sort)}</td>
                </tr>
                <tr>
                  <th scope="row">Stamps</th>
                  <td>
                    {data.parameters.stamps.length === 0
                      ? 'None'
                      : data.parameters.stamps
                          .map((s) => `${humanizeToken(s.position)}: ${s.kind}`)
                          .join('; ')}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Redactions</th>
                  <td>
                    {data.parameters.redactions.stage} stage, image-only{' '}
                    {data.parameters.redactions.enforceImageOnly ? 'enforced' : 'not enforced'}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Bates format</th>
                  <td className="mono">{formatBates(data.parameters.bates)}</td>
                </tr>
                <tr>
                  <th scope="row">Filenames</th>
                  <td>{humanizeToken(data.parameters.filenames)}</td>
                </tr>
              </tbody>
            </Table>

            <h2>Runs</h2>
            <TruthNotice kind="defensibility" variant="warning" />
            {data.runs.length === 0 ? (
              <EmptyState title="No runs yet" description="Submit the production to start a run." />
            ) : (
              <Table caption="Production runs" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Status</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Bates range</th>
                    <th scope="col">Exceptions</th>
                    <th scope="col">Manifest (SHA-256)</th>
                    <th scope="col">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((run) => {
                    const exceptionTotal = Object.values(run.exceptionCounts).reduce(
                      (a, b) => a + b,
                      0,
                    );
                    return (
                      <tr key={run.id}>
                        <td>#{run.runNumber}</td>
                        <td>
                          <StatusPill status={run.status} />
                        </td>
                        <td>
                          {Object.entries(run.progress)
                            .map(([k, v]) => `${humanizeToken(k)}: ${v}`)
                            .join(' · ') || '—'}
                        </td>
                        <td className="mono">
                          {run.batesStart && run.batesEnd
                            ? `${run.batesStart} – ${run.batesEnd}`
                            : '—'}
                        </td>
                        <td>{exceptionTotal}</td>
                        <td className="mono">
                          {run.manifestSha256 ? `${run.manifestSha256.slice(0, 16)}…` : '—'}
                        </td>
                        <td>
                          {run.status === 'ready' || run.status === 'released' ? (
                            <a
                              href={apiDownloadUrl(
                                `/api/v1/productions/${data.id}/runs/${run.id}/download`,
                              )}
                            >
                              Download
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}

            <h2>Exceptions</h2>
            <QueryBoundary
              isPending={exceptions.isPending}
              error={exceptions.error}
              data={exceptions.data}
              onRetry={() => void exceptions.refetch()}
            >
              {(page) =>
                page.items.length === 0 ? (
                  <p>No exceptions recorded for this production.</p>
                ) : (
                  <Table caption="Production exceptions" captionHidden>
                    <thead>
                      <tr>
                        <th scope="col">Kind</th>
                        <th scope="col">Message</th>
                        <th scope="col">Item</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((e) => (
                        <tr key={e.id}>
                          <td>{humanizeToken(e.kind)}</td>
                          <td>{e.message}</td>
                          <td className="mono">{e.itemRef ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )
              }
            </QueryBoundary>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
