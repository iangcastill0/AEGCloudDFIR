'use client';
import Link from 'next/link';
import { EmptyState, Notice, Table } from '@evidencevault/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { useCollections, useExports, useMe, useProductions, isCollectionActive } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';

export default function DashboardPage() {
  const me = useMe();
  const collections = useCollections();
  const exports = useExports();
  const productions = useProductions();

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div className="button-row">
          <Link className="ev-button ev-button--primary" href="/collections/new">
            New collection
          </Link>
          <Link className="ev-button ev-button--secondary" href="/review">
            Open review
          </Link>
        </div>
      </div>

      {me.data && me.data.tenant === null ? (
        <Notice variant="warning">
          No tenant selected. <Link href="/auth/tenant">Choose a tenant</Link> to begin.
        </Notice>
      ) : null}

      <div className="card-grid">
        <section className="card" aria-labelledby="dash-active">
          <h2 id="dash-active">Active collections</h2>
          <QueryBoundary
            isPending={collections.isPending}
            error={collections.error}
            data={collections.data}
            onRetry={() => void collections.refetch()}
          >
            {(data) => {
              const active = data.items.filter((c) => isCollectionActive(c.status));
              if (active.length === 0)
                return (
                  <EmptyState
                    title="No collections running"
                    description="Start a collection to preserve email and drive data."
                    action={<Link href="/collections/new">Start a collection</Link>}
                  />
                );
              return (
                <Table caption="Active collections" captionHidden>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Status</th>
                      <th scope="col">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link href={`/collections/${c.id}`}>{c.name}</Link>
                        </td>
                        <td>
                          <StatusPill status={c.status} />
                        </td>
                        <td>{formatDateTime(c.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              );
            }}
          </QueryBoundary>
        </section>

        <section className="card" aria-labelledby="dash-exports">
          <h2 id="dash-exports">Recent exports</h2>
          <QueryBoundary
            isPending={exports.isPending}
            error={exports.error}
            data={exports.data}
            onRetry={() => void exports.refetch()}
          >
            {(data) =>
              data.items.length === 0 ? (
                <EmptyState
                  title="No exports yet"
                  action={<Link href="/exports">Create an export</Link>}
                />
              ) : (
                <Table caption="Recent exports" captionHidden>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.slice(0, 5).map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Link href="/exports">{e.name}</Link>
                        </td>
                        <td>{e.kind}</td>
                        <td>
                          <StatusPill status={e.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )
            }
          </QueryBoundary>
        </section>

        <section className="card" aria-labelledby="dash-productions">
          <h2 id="dash-productions">Recent productions</h2>
          <QueryBoundary
            isPending={productions.isPending}
            error={productions.error}
            data={productions.data}
            onRetry={() => void productions.refetch()}
          >
            {(data) =>
              data.items.length === 0 ? (
                <EmptyState
                  title="No productions yet"
                  action={<Link href="/productions/new">Create a production</Link>}
                />
              ) : (
                <Table caption="Recent productions" captionHidden>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Latest run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.slice(0, 5).map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/productions/${p.id}`}>{p.name}</Link>
                        </td>
                        <td>
                          {p.latestRunStatus ? <StatusPill status={p.latestRunStatus} /> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )
            }
          </QueryBoundary>
        </section>

        <section className="card" aria-labelledby="dash-links">
          <h2 id="dash-links">Quick links</h2>
          <ul>
            <li>
              <Link href="/connectors">Connect a Microsoft or Google account</Link>
            </li>
            <li>
              <Link href="/collections">All collections</Link>
            </li>
            <li>
              <Link href="/cases">Cases and legal holds</Link>
            </li>
            <li>
              <Link href="/audit">Audit log</Link>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
