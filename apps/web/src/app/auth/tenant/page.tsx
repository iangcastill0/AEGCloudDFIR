'use client';
import { Button, EmptyState, Table } from '@evidencevault/ui';
import { QueryBoundary } from '@/components/shared';
import { useAuthTenants, useSelectTenant } from '@/lib/hooks';

export default function TenantPickerPage() {
  const tenants = useAuthTenants();
  const select = useSelectTenant();

  return (
    <>
      <h1>Choose a tenant</h1>
      <p>Your account belongs to the following tenants. Pick one to work in.</p>
      <QueryBoundary
        isPending={tenants.isPending}
        error={tenants.error}
        data={tenants.data}
        onRetry={() => void tenants.refetch()}
      >
        {(data) =>
          data.tenants.length === 0 ? (
            <EmptyState
              title="No tenant memberships"
              description="Ask an organization administrator to invite you to a tenant."
            />
          ) : (
            <Table caption="Tenants you belong to" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => (
                  <tr key={t.tenantId}>
                    <td>{t.name}</td>
                    <td>{t.roles.join(', ') || '—'}</td>
                    <td>{t.status}</td>
                    <td>
                      <Button
                        small
                        disabled={t.status !== 'active'}
                        busy={select.isPending && select.variables === t.tenantId}
                        onClick={() =>
                          select.mutate(t.tenantId, {
                            onSuccess: () => window.location.assign('/'),
                          })
                        }
                      >
                        Use this tenant
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
      {select.isError ? (
        <p role="alert" className="ev-field__error">
          Could not select tenant. Try again.
        </p>
      ) : null}
    </>
  );
}
