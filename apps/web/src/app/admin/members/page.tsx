'use client';
import { useState } from 'react';
import { Button, EmptyState, Notice, Select, Table, TextInput } from '@aeg-clouddfir/ui';
import { QueryBoundary } from '@/components/shared';
import { SignupLinkPanel } from '@/components/SignupLinkPanel';
import { useCreateInvite, useMe, useMembers } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

const ROLE_OPTIONS = [
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'case_manager', label: 'Case manager' },
  { value: 'org_admin', label: 'Org admin' },
  { value: 'read_only', label: 'Read only' },
  { value: 'production_manager', label: 'Production manager' },
  { value: 'auditor', label: 'Auditor' },
];

export default function MembersPage() {
  const me = useMe();
  const isAdmin = me.data?.roles.includes('org_admin') ?? false;
  const tenantId = isAdmin ? me.data?.tenant?.id : undefined;
  const members = useMembers(tenantId);
  const invite = useCreateInvite(tenantId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('reviewer');
  const [copied, setCopied] = useState(false);

  return (
    <>
      <h1>Tenant members</h1>
      {me.data && !isAdmin ? (
        <Notice variant="warning">
          Member administration requires the <strong>org admin</strong> role. (The server enforces
          this independently of this screen.)
        </Notice>
      ) : (
        <>
          {isAdmin && tenantId ? (
            <div style={{ marginBottom: '2rem' }}>
              <SignupLinkPanel tenantId={tenantId} />
            </div>
          ) : null}
          {isAdmin ? (
            <section style={{ marginBottom: '2rem' }}>
              <h2>Invite a person by email</h2>
              <p>
                Optional. A one-time link for a specific address and role. They must sign in with
                that same email.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setCopied(false);
                  invite.mutate({ email, role });
                }}
              >
                <TextInput
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                <Select
                  label="Role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  options={ROLE_OPTIONS}
                />
                {invite.isError ? (
                  <p role="alert" className="cdfir-field__error">
                    {errorMessage(invite.error)}
                  </p>
                ) : null}
                <Button type="submit" busy={invite.isPending}>
                  Create invite
                </Button>
              </form>
              {invite.data ? (
                <Notice variant="info" title="Invite created">
                  <p>
                    Send this link to {invite.data.email}. It expires{' '}
                    {new Date(invite.data.expiresAt).toLocaleString()}.
                  </p>
                  <p>
                    <code style={{ wordBreak: 'break-all' }}>{invite.data.inviteUrl}</code>
                  </p>
                  <Button
                    small
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(invite.data.inviteUrl).then(() => {
                        setCopied(true);
                      });
                    }}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </Notice>
              ) : null}
            </section>
          ) : null}
          <QueryBoundary
            isPending={me.isPending || members.isPending}
            error={me.error ?? members.error}
            data={members.data}
            onRetry={() => void members.refetch()}
          >
            {(data) =>
              data.items.length === 0 ? (
                <EmptyState
                  title="No members"
                  description="People who join this organization will appear here."
                />
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
        </>
      )}
    </>
  );
}
