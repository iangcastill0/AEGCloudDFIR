'use client';
import { EmptyState, Notice, Table } from '@aeg-clouddfir/ui';
import { QueryBoundary } from '@/components/shared';
import { useMe, useMembers } from '@/lib/hooks';

export default function MembersPage() {
  const me = useMe();
  const isAdmin = me.data?.roles.includes('org_admin') ?? false;
  const members = useMembers(isAdmin ? me.data?.tenant?.id : undefined);

  return (
    <>
      <h1>Tenant members</h1>
      {me.data && !isAdmin ? (
        <Notice variant="warning">
          Member administration requires the <strong>org admin</strong> role. (The server enforces
          this independently of this screen.)
        </Notice>
      ) : (
        <QueryBoundary
          isPending={me.isPending || members.isPending}
          error={me.error ?? members.error}
          data={members.data}
          onRetry={() => void members.refetch()}
        >
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title="No members" description="Invited members will appear here." />
            ) : (
              <Table caption="Members and roles" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Status</th>
                    <th scope="col">Roles</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.membershipId}>
                      <td>{m.displayName || '—'}</td>
                      <td>{m.email}</td>
                      <td>{m.status}</td>
                      <td>{m.roles.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      )}
    </>
  );
}
