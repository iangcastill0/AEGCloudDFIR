'use client';
import { useState } from 'react';
import { Button, EmptyState, Notice, StatusLive, Table } from '@aeg-clouddfir/ui';
import { QueryBoundary } from '@/components/shared';
import { useAuditPage, useAuditVerify } from '@/lib/hooks';
import type { auditListResponse } from '@/lib/schemas';
import type { z } from 'zod';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

type AuditEvent = z.infer<typeof auditListResponse>['items'][number];

export default function AuditPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<AuditEvent[]>([]);
  const page = useAuditPage(cursor);
  const verify = useAuditVerify();

  const items = (() => {
    const pageItems = page.data?.items ?? [];
    const seen = new Set(accumulated.map((e) => e.id));
    return [...accumulated, ...pageItems.filter((e) => !seen.has(e.id))];
  })();

  return (
    <>
      <div className="page-header">
        <h1>Audit log</h1>
        <Button variant="secondary" onClick={() => verify.mutate()} busy={verify.isPending}>
          Verify hash chain
        </Button>
      </div>

      <StatusLive politeness="polite">
        {verify.isPending ? 'Verifying audit chain…' : ''}
      </StatusLive>
      {verify.data ? (
        <Notice
          variant={verify.data.valid ? 'info' : 'warning'}
          title={verify.data.valid ? 'Chain valid' : 'Chain INVALID'}
        >
          Checked {verify.data.checkedCount} event(s).
          {verify.data.valid
            ? ' Every event hash links correctly to its predecessor.'
            : ` First invalid sequence: ${verify.data.firstInvalidSequence ?? 'unknown'}. ${verify.data.reason}`}
        </Notice>
      ) : null}
      {verify.isError ? (
        <Notice variant="warning">Verification failed: {errorMessage(verify.error)}</Notice>
      ) : null}

      <QueryBoundary
        isPending={page.isPending && items.length === 0}
        error={page.error}
        data={page.data}
        onRetry={() => void page.refetch()}
      >
        {(data) =>
          items.length === 0 ? (
            <EmptyState
              title="No audit events"
              description="Actions in this tenant will appear here."
            />
          ) : (
            <>
              <Table caption="Audit events (newest first)" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">Seq</th>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target</th>
                    <th scope="col">Request</th>
                    <th scope="col">Event hash</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{e.sequence}</td>
                      <td>{formatDateTime(e.occurredAt)}</td>
                      <td>{e.actorDisplay}</td>
                      <td>{e.action}</td>
                      <td className="mono">
                        {e.targetType}
                        {e.targetId ? `:${e.targetId.slice(0, 8)}…` : ''}
                      </td>
                      <td className="mono">{e.requestId}</td>
                      <td className="mono">{e.eventHash.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {data.nextCursor ? (
                <div className="button-row">
                  <Button
                    variant="secondary"
                    busy={page.isFetching}
                    onClick={() => {
                      setAccumulated(items);
                      setCursor(data.nextCursor);
                    }}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )
        }
      </QueryBoundary>
    </>
  );
}
