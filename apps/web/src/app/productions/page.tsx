'use client';
import Link from 'next/link';
import { EmptyState, Table } from '@evidencevault/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { useProductions } from '@/lib/hooks';
import { formatDateTime } from '@/lib/format';

export default function ProductionsPage() {
  const productions = useProductions();
  return (
    <>
      <div className="page-header">
        <h1>Productions</h1>
        <Link className="ev-button ev-button--primary" href="/productions/new">
          New production
        </Link>
      </div>
      <QueryBoundary
        isPending={productions.isPending}
        error={productions.error}
        data={productions.data}
        onRetry={() => void productions.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No productions"
              description="Produce stamped, Bates-numbered document sets from tags or saved searches."
              action={
                <Link className="ev-button ev-button--primary" href="/productions/new">
                  Create a production
                </Link>
              }
            />
          ) : (
            <Table caption="Productions" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Description</th>
                  <th scope="col">Latest run</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/productions/${p.id}`}>{p.name}</Link>
                    </td>
                    <td>{p.description || '—'}</td>
                    <td>{p.latestRunStatus ? <StatusPill status={p.latestRunStatus} /> : '—'}</td>
                    <td>{formatDateTime(p.createdAt)}</td>
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
