'use client';
import { Notice, Table } from '@evidencevault/ui';
import { AUTHENTIK_URL } from '@/lib/api';
import { useMe } from '@/lib/hooks';

/**
 * Jumping-off point into the Authentik admin console. AEG-CloudDFIR delegates
 * all login to Authentik via standards-compliant OIDC, so identity changes
 * (users, groups, MFA policy, the OIDC application) are made in Authentik's own
 * dashboard — which cannot be embedded here (it denies iframing), so every
 * link opens Authentik in a new tab.
 */
const ADMIN_LINKS: Array<{ label: string; path: string; description: string }> = [
  {
    label: 'Admin console',
    path: '/if/admin/',
    description: 'Full Authentik administration: overview, system status, everything below.',
  },
  {
    label: 'Users',
    path: '/if/admin/#/identity/users',
    description: 'Create, disable, and reset users; assign group membership.',
  },
  {
    label: 'Groups',
    path: '/if/admin/#/identity/groups',
    description:
      'Manage groups used for optional group→role mapping (ev-org-admins, ev-case-managers, ev-reviewers).',
  },
  {
    label: 'Applications',
    path: '/if/admin/#/core/applications',
    description: 'The AEG-CloudDFIR application and its bindings.',
  },
  {
    label: 'Providers',
    path: '/if/admin/#/core/providers',
    description: 'The AEG-CloudDFIR OIDC provider — client id, redirect URI, signing key, scopes.',
  },
  {
    label: 'Flows & stages',
    path: '/if/admin/#/flow/flows',
    description: 'Authentication/enrollment flows and MFA (TOTP/WebAuthn) stages.',
  },
];

export default function AuthAdminPage() {
  const me = useMe();
  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <>
      <h1>Identity provider (Authentik)</h1>
      <p>
        AEG-CloudDFIR does not manage its own passwords — sign-in is delegated to Authentik over
        OpenID Connect. Use the links below to open the Authentik admin console in a new tab and
        manage users, groups, MFA policy, and the AEG-CloudDFIR OIDC application.
      </p>

      <Notice variant="info">
        You must sign in to Authentik as an Authentik administrator to make changes here. Your
        AEG-CloudDFIR role ({me.data?.roles.join(', ') || 'none selected'}) does not grant Authentik
        access — the two systems have separate authorization.
      </Notice>

      <p style={{ margin: '1rem 0' }}>
        <a
          className="ev-button ev-button--primary"
          href={`${AUTHENTIK_URL}/if/admin/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Authentik admin console ↗
        </a>{' '}
        <a
          className="ev-button ev-button--secondary"
          href={`${AUTHENTIK_URL}/if/user/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          My Authentik account ↗
        </a>
      </p>

      <h2>Admin shortcuts</h2>
      <Table caption="Authentik admin deep links">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">What you manage</th>
            <th scope="col">Open</th>
          </tr>
        </thead>
        <tbody>
          {ADMIN_LINKS.map((link) => (
            <tr key={link.path}>
              <th scope="row">{link.label}</th>
              <td>{link.description}</td>
              <td>
                <a href={`${AUTHENTIK_URL}${link.path}`} target="_blank" rel="noopener noreferrer">
                  Open ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {isDev ? (
        <Notice variant="warning">
          <strong>Local development only.</strong> The compose stack bootstraps an Authentik admin{' '}
          <code>akadmin@localhost</code> with the password from{' '}
          <code>EV_LOCAL_AUTHENTIK_ADMIN_PASSWORD</code> (default <code>admin-local-only</code>).
          Change it before exposing this instance. These credentials do not exist in production
          deployments.
        </Notice>
      ) : null}

      <h2>Group → role mapping</h2>
      <p>
        When <code>EV_OIDC_GROUP_CLAIM</code> is configured, Authentik group membership is mapped to
        AEG-CloudDFIR roles on every login (for example <code>ev-org-admins → org_admin</code>).
        Manage the groups in Authentik above; manage the mapping via{' '}
        <code>EV_OIDC_GROUP_ROLE_MAP</code>. See <code>docs/guides/authentik-setup.md</code> for the
        full configuration.
      </p>
    </>
  );
}
