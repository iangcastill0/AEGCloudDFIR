'use client';
import { useState } from 'react';
import {
  Button,
  Dialog,
  EmptyState,
  Notice,
  StatusLive,
  Table,
  TextArea,
  TextInput,
} from '@aeg-clouddfir/ui';
import { ConfirmDialog, QueryBoundary, StatusPill, TruthNotice } from '@/components/shared';
import {
  useConnectors,
  useCreateConnector,
  useRevokeConnector,
  useTestConnector,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

type OrgSetup = { provider: 'microsoft' | 'google' } | null;

export default function ConnectorsPage() {
  const connectors = useConnectors();
  const create = useCreateConnector();
  const test = useTestConnector();
  const revoke = useRevokeConnector();

  const [orgSetup, setOrgSetup] = useState<OrgSetup>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [statusText, setStatusText] = useState('');

  function connectDelegated(provider: 'microsoft' | 'google') {
    setStatusText(`Starting ${provider} sign-in…`);
    create.mutate(
      { provider, mode: 'delegated' },
      {
        onSuccess: (data) => {
          if (data.authorizationUrl) {
            window.location.assign(data.authorizationUrl);
          } else {
            setStatusText('Connector created, but no authorization URL was returned.');
          }
        },
        onError: (err) => setStatusText(errorMessage(err)),
      },
    );
  }

  function runTest(id: string) {
    setStatusText('Testing connector…');
    test.mutate(id, {
      onSuccess: (r) =>
        setStatusText(
          r.ok ? `Connector test passed. ${r.message}` : `Connector test failed. ${r.message}`,
        ),
      onError: (err) => setStatusText(errorMessage(err)),
    });
  }

  return (
    <>
      <div className="page-header">
        <h1>Connectors</h1>
      </div>

      <StatusLive politeness="polite">{statusText}</StatusLive>

      <section className="card" aria-labelledby="connect-personal">
        <h2 id="connect-personal">Connect a personal (delegated) account</h2>
        <TruthNotice kind="delegatedAccess" />
        <div className="button-row">
          <Button onClick={() => connectDelegated('microsoft')} busy={create.isPending}>
            Connect Microsoft account
          </Button>
          <Button onClick={() => connectDelegated('google')} busy={create.isPending}>
            Connect Google account
          </Button>
        </div>
      </section>

      <section
        className="card"
        aria-labelledby="connect-org"
        style={{ marginTop: 'var(--space-4)' }}
      >
        <h2 id="connect-org">Organization-wide access</h2>
        <p>
          Organization mode lets authorized staff collect from any custodian the credential can
          reach. Setup requires provider-side admin action.
        </p>
        <div className="button-row">
          <Button variant="secondary" onClick={() => setOrgSetup({ provider: 'microsoft' })}>
            Set up Microsoft 365 (Entra) org access
          </Button>
          <Button variant="secondary" onClick={() => setOrgSetup({ provider: 'google' })}>
            Set up Google Workspace org access
          </Button>
        </div>
      </section>

      <section aria-labelledby="connector-list" style={{ marginTop: 'var(--space-4)' }}>
        <h2 id="connector-list">Configured connectors</h2>
        <QueryBoundary
          isPending={connectors.isPending}
          error={connectors.error}
          data={connectors.data}
          onRetry={() => void connectors.refetch()}
        >
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState
                title="No connectors yet"
                description="Connect an account above to begin."
              />
            ) : (
              <Table caption="Configured connectors" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td>{c.provider}</td>
                      <td>{c.mode}</td>
                      <td>{c.externalIdentity ?? c.label ?? '—'}</td>
                      <td>
                        <StatusPill status={c.status} />
                      </td>
                      <td>
                        <div className="button-row" style={{ margin: 0 }}>
                          <Button
                            small
                            variant="secondary"
                            onClick={() => runTest(c.id)}
                            busy={test.isPending && test.variables === c.id}
                          >
                            Test
                          </Button>
                          <Button
                            small
                            variant="danger"
                            onClick={() =>
                              setRevokeTarget({ id: c.id, name: c.externalIdentity ?? c.provider })
                            }
                          >
                            Revoke
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      </section>

      {orgSetup ? (
        <OrgSetupDialog
          provider={orgSetup.provider}
          onClose={() => setOrgSetup(null)}
          onStatus={setStatusText}
        />
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke connector"
        body={
          <p>
            Revoking <strong>{revokeTarget?.name}</strong> stops future collections from using it.
            Existing preserved evidence is not affected.
          </p>
        }
        confirmLabel="Revoke connector"
        destructive
        busy={revoke.isPending}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (!revokeTarget) return;
          revoke.mutate(revokeTarget.id, {
            onSuccess: () => {
              setStatusText('Connector revoked.');
              setRevokeTarget(null);
            },
            onError: (err) => setStatusText(errorMessage(err)),
          });
        }}
      />
    </>
  );
}

function OrgSetupDialog({
  provider,
  onClose,
  onStatus,
}: {
  provider: 'microsoft' | 'google';
  onClose: () => void;
  onStatus: (text: string) => void;
}) {
  const create = useCreateConnector();
  const [entraTenantId, setEntraTenantId] = useState('');
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  function submit() {
    setError('');
    create.mutate(
      {
        provider,
        mode: 'organization',
        organization:
          provider === 'microsoft'
            ? { entraTenantId: entraTenantId.trim() }
            : {
                serviceAccountJson,
                allowedDomains: allowedDomains
                  .split(/[\n,]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
                adminEmail: adminEmail.trim(),
              },
      },
      {
        onSuccess: (data) => {
          if (provider === 'microsoft' && data.adminConsentUrl) {
            setConsentUrl(data.adminConsentUrl);
            onStatus('Connector created. Grant admin consent to finish setup.');
          } else {
            onStatus('Organization connector created.');
            onClose();
          }
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  const microsoftValid = entraTenantId.trim().length > 0;
  const googleValid = serviceAccountJson.trim().length > 0 && adminEmail.trim().length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        provider === 'microsoft'
          ? 'Microsoft 365 organization access'
          : 'Google Workspace organization access'
      }
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {consentUrl === null ? (
            <Button
              onClick={submit}
              busy={create.isPending}
              disabled={provider === 'microsoft' ? !microsoftValid : !googleValid}
            >
              Create connector
            </Button>
          ) : null}
        </>
      }
    >
      {provider === 'microsoft' ? (
        <>
          <TextInput
            label="Entra tenant ID"
            hint="Directory (tenant) ID of the Microsoft Entra tenant to connect."
            value={entraTenantId}
            onChange={(e) => setEntraTenantId(e.target.value)}
          />
          {consentUrl ? (
            <Notice variant="info">
              Connector created. An Entra global administrator must grant consent:{' '}
              <a href={consentUrl} target="_blank" rel="noreferrer">
                open the admin consent page
              </a>
              .
            </Notice>
          ) : null}
        </>
      ) : (
        <>
          <Notice variant="warning">
            The service-account key is stored encrypted and can never be viewed again after saving.
            Keep your own secure copy in accordance with your key-handling policy.
          </Notice>
          <TextArea
            label="Service account JSON key"
            hint="Paste the full JSON key for a service account with domain-wide delegation."
            rows={8}
            value={serviceAccountJson}
            onChange={(e) => setServiceAccountJson(e.target.value)}
          />
          <TextInput
            label="Allowed domains"
            hint="Comma-separated list of Workspace domains this connector may collect from."
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
          />
          <TextInput
            label="Admin email"
            hint="Workspace admin the service account impersonates for directory lookups."
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </>
      )}
      {error ? (
        <p role="alert" className="cdfir-field__error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
