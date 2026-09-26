'use client';
import { useState } from 'react';
import { Button, EmptyState, Notice, Select, Table, TextInput } from '@aeg-clouddfir/ui';
import { QueryBoundary } from '@/components/shared';
import { SignupLinkPanel } from '@/components/SignupLinkPanel';
import { useCreateInvite, useGrantMemberRole, useMe, useMembers } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

/** Email invites cannot prove mailbox ownership; elevated roles are granted after join. */
const INVITE_ROLE_OPTIONS = [
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'read_only', label: 'Read only' },
  { value: 'auditor', label: 'Auditor' },
];

const GRANT_ROLE_OPTIONS = [
  { value: 'org_admin', label: 'Org admin' },
  { value: 'case_manager', label: 'Case manager' },
  { value: 'production_manager', label: 'Production manager' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'read_only', label: 'Read only' },
  { value: 'auditor', label: 'Auditor' },
];

export default function MembersPage() {
  const me = useMe();
  const isAdmin = me.data?.roles.includes('org_admin') ?? false;
  const tenantId = isAdmin ? me.data?.tenant?.id : undefined;
  const members = useMembers(tenantId);
  const invite = useCreateInvite(tenantId);
  const grant = useGrantMemberRole(tenantId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('reviewer');
  const [copied, setCopied] = useState(false);
  const [grantMembershipId, setGrantMembershipId] = useState('');
  const [grantRole, setGrantRole] = useState('case_manager');

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
                Optional. A one-time link for a specific address. They must sign in with that same
                email. Sign-up does not verify the mailbox, so this path only grants reviewer,
                read-only, or auditor. Grant elevated roles from the table after you confirm who
                joined.
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
                  options={INVITE_ROLE_OPTIONS}
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
          {isAdmin ? (
            <section style={{ marginBottom: '2rem' }}>
              <h2>Grant a role to a member</h2>
              <p>
                Use this for org admin, case manager, and production manager. Pick the person from
                the members list so the grant is tied to their account, not a self-asserted email.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!grantMembershipId) return;
                  grant.mutate({ membershipId: grantMembershipId, role: grantRole });
                }}
              >
                <Select
                  label="Member"
                  value={grantMembershipId}
                  onChange={(e) => setGrantMembershipId(e.target.value)}
                  options={[
                    { value: '', label: 'Select a member…' },
                    ...(members.data?.items ?? []).map((m) => ({
                      value: m.membershipId,
                      label: `${m.displayName || m.email} (${m.email})`,
                    })),
                  ]}
                />
                <Select
                  label="Role to grant"
                  value={grantRole}
                  onChange={(e) => setGrantRole(e.target.value)}
                  options={GRANT_ROLE_OPTIONS}
                />
                {grant.isError ? (
                  <p role="alert" className="cdfir-field__error">
                    {errorMessage(grant.error)}
                  </p>
                ) : null}
                {grant.isSuccess ? (
                  <Notice variant="info">
                    {grant.data.granted
                      ? `Granted ${grant.data.role}.`
                      : `They already have ${grant.data.role}.`}
                  </Notice>
                ) : null}
                <Button type="submit" busy={grant.isPending} disabled={!grantMembershipId}>
                  Grant role
                </Button>
              </form>
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
