'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, Notice, Table, TextInput } from '@aeg-clouddfir/ui';
import { QueryBoundary } from '@/components/shared';
import { useAuthTenants, useCreateTenant, useSelectTenant } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export default function TenantPickerPage() {
  const tenants = useAuthTenants();
  const select = useSelectTenant();
  const create = useCreateTenant();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  function onNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugFromName(value));
  }

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
        {(data) => (
          <>
            {data.tenants.length === 0 ? (
              <EmptyState
                title="No tenant memberships"
                description="Create an organization, or join one with a link from that organization."
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
            )}

            {data.canCreateTenant ? (
              <section style={{ marginTop: '2rem' }}>
                <h2>Create an organization</h2>
                <p>
                  You will be its admin. Teammates join later with the standing link on Members.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate({ name, slug }, { onSuccess: () => window.location.assign('/') });
                  }}
                >
                  <TextInput
                    label="Organization name"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    required
                    autoComplete="organization"
                  />
                  <TextInput
                    label="URL slug"
                    hint="Lowercase letters, numbers, and hyphens. Must be unique."
                    value={slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(e.target.value);
                    }}
                    required
                  />
                  {create.isError ? (
                    <p role="alert" className="cdfir-field__error">
                      {errorMessage(create.error)}
                    </p>
                  ) : null}
                  <Button type="submit" busy={create.isPending}>
                    Create organization
                  </Button>
                </form>
              </section>
            ) : data.tenants.length === 0 ? (
              <Notice variant="info">
                Self-serve create is off on this server. Ask an administrator to invite you.
              </Notice>
            ) : null}

            <p style={{ marginTop: '1.5rem' }}>
              <Link href="/signup">I have a sign-up link</Link>
            </p>
          </>
        )}
      </QueryBoundary>
      {select.isError ? (
        <p role="alert" className="cdfir-field__error">
          Could not select tenant. Try again.
        </p>
      ) : null}
    </>
  );
}
