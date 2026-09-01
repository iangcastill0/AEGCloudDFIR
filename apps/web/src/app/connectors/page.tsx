'use client';
import { useState } from 'react';
import {
  Button,
  Checkbox,
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
  useSetupOrgConnector,
  useTestConnector,
} from '@/lib/hooks';
import { ImapConnectDialog } from '@/components/ImapConnectDialog';
import {
  buildCreateConnector,
  buildGoogleOrgSetup,
  buildMicrosoftOrgSetup,
} from '@/lib/connector-setup';
import { errorMessage } from '@/lib/errors';

type OrgSetup = { provider: 'microsoft' | 'google' } | null;

export default function ConnectorsPage() {
  // Revoked connectors are hidden by default. The row is kept in the database —
  // collections reference it as the credential that collected them — so this
  // toggle is the way back to it.
  const [showRevoked, setShowRevoked] = useState(false);
  const connectors = useConnectors(showRevoked);
  const create = useCreateConnector();
  const test = useTestConnector();
  const revoke = useRevokeConnector();

  const [orgSetup, setOrgSetup] = useState<OrgSetup>(null);
  const [imapOpen, setImapOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [statusText, setStatusText] = useState('');
  const [label, setLabel] = useState('');

  function connectDelegated(provider: 'microsoft' | 'google' | 'dropbox') {
    setStatusText(`Starting ${provider} sign-in…`);
    create.mutate(
      // A label is required by the API. Leaving it out is what made every
      // Connect click fail with 400 before the provider was ever contacted.
      buildCreateConnector({ provider, mode: 'delegated', label: label.trim(), now: new Date() }),
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
        <TextInput
          label="Label (optional)"
          hint="A name for this connection until the account signs in. Left blank, the provider and today's date are used."
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div className="button-row">
          <Button onClick={() => connectDelegated('microsoft')} busy={create.isPending}>
            Connect Microsoft account
          </Button>
          <Button onClick={() => connectDelegated('google')} busy={create.isPending}>
            Connect Google account
          </Button>
          <Button onClick={() => connectDelegated('dropbox')} busy={create.isPending}>
            Connect Dropbox account
          </Button>
        </div>
      </section>

      <section
        className="card"
        aria-labelledby="connect-imap"
        style={{ marginTop: 'var(--space-4)' }}
      >
        <h2 id="connect-imap">Connect a mailbox by IMAP</h2>
        <p>
          For mail Microsoft and Google cannot see — Yahoo, iCloud, AOL, or a client&apos;s own mail
          server. IMAP returns the original message bytes, so what is preserved is the message as
          the server holds it.
        </p>
        <div className="button-row">
          <Button variant="secondary" onClick={() => setImapOpen(true)}>
            Connect IMAP mailbox
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
        <Checkbox
          label="Show revoked connectors"
          checked={showRevoked}
          onChange={(e) => setShowRevoked(e.target.checked)}
        />
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
                        {c.provider === 'upload' ? (
                          // Created and reused automatically for preserved
                          // container files. There is no provider-side grant to
                          // test, and revoking it would only leave a revoked row
                          // that the next upload collection reuses anyway.
                          <span className="cdfir-field__hint">Managed automatically</span>
                        ) : (
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
                                setRevokeTarget({
                                  id: c.id,
                                  name: c.externalIdentity ?? c.provider,
                                })
                              }
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryBoundary>
      </section>

      {imapOpen ? (
        <ImapConnectDialog onClose={() => setImapOpen(false)} onStatus={setStatusText} />
      ) : null}

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
              setStatusText(
                showRevoked
                  ? 'Connector revoked. Its stored tokens are deleted.'
                  : 'Connector revoked and removed from the list. Its stored tokens are deleted; the record is kept for collections that used it.',
              );
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
  const setupOrg = useSetupOrgConnector();
  const [entraTenantId, setEntraTenantId] = useState('');
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [label, setLabel] = useState('');
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  /**
   * Two steps, in this order: create the connector, then send its credential to
   * /connectors/:id/org. The old code put the credential inside the create call,
   * where the API never looked at it — so organization mode could not work even
   * once the label was fixed.
   */
  function submit() {
    setError('');
    let body: unknown;
    try {
      body =
        provider === 'microsoft'
          ? buildMicrosoftOrgSetup(entraTenantId)
          : buildGoogleOrgSetup({ serviceAccountJson, allowedDomains, adminEmail });
    } catch {
      setError('Check the fields above: something is missing or not in the expected form.');
      return;
    }

    create.mutate(
      buildCreateConnector({
        provider,
        mode: 'organization',
        label: label.trim(),
        now: new Date(),
      }),
      {
        onSuccess: (created) => {
          setupOrg.mutate(
            // The connector is nested in the response, not spread into it.
            { id: created.connector.id, body },
            {
              onSuccess: (result) => {
                if (result.adminConsentUrl !== undefined) {
                  setConsentUrl(result.adminConsentUrl);
                  onStatus('Connector created. Grant admin consent to finish setup.');
                  return;
                }
                onStatus('Organization connector created.');
                onClose();
              },
              // The connector row exists at this point; say so, so the operator
              // does not create a second one chasing the same error.
              onError: (err) =>
                setError(
                  `The connector was created but its credential was rejected: ${errorMessage(err)}`,
                ),
            },
          );
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
              busy={create.isPending || setupOrg.isPending}
              disabled={provider === 'microsoft' ? !microsoftValid : !googleValid}
            >
              Create connector
            </Button>
          ) : null}
        </>
      }
    >
      <TextInput
        label="Label (optional)"
        hint="A name for this connection. Left blank, the provider and today's date are used."
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
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
