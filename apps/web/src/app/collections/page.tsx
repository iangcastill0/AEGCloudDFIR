'use client';
import Link from 'next/link';
import { EmptyState, Table } from '@aeg-clouddfir/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { useCollections } from '@/lib/hooks';
import { formatDateTime, humanizeToken } from '@/lib/format';

export default function CollectionsPage() {
  const collections = useCollections();
  return (
    <>
      <div className="page-header">
        <h1>Collections</h1>
        <Link className="cdfir-button cdfir-button--primary" href="/collections/new">
          New collection
        </Link>
      </div>
      <QueryBoundary
        isPending={collections.isPending}
        error={collections.error}
        data={collections.data}
        onRetry={() => void collections.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No collections"
              description="Preserved collections will appear here."
              action={
                <Link className="cdfir-button cdfir-button--primary" href="/collections/new">
                  Start your first collection
                </Link>
              }
            />
          ) : (
            <Table caption="All collections" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Sources</th>
                  <th scope="col">Status</th>
                  <th scope="col">Completeness</th>
                  <th scope="col">Started</th>
                  <th scope="col">Finished</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/collections/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{c.kind}</td>
                    <td>{c.sources.join(', ')}</td>
                    <td>
                      <StatusPill status={c.status} />
                    </td>
                    <td>{c.completeness ? humanizeToken(c.completeness) : '—'}</td>
                    <td>{formatDateTime(c.startedAt)}</td>
                    <td>{formatDateTime(c.finishedAt)}</td>
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
