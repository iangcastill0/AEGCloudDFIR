'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Notice,
  ProgressBar,
  RadioGroup,
  Select,
  StatusLive,
  Stepper,
  Table,
  TextArea,
  TextInput,
  VisuallyHidden,
} from '@aeg-clouddfir/ui';
import { QueryBoundary, TruthNotice } from '@/components/shared';
import {
  PST_EXTRACTION_NOTICE,
  STEP_START,
  buildCreateRequest,
  canAdvance,
  freshWizard,
  hydrateWizard,
  isAuditOnly,
  isUploadCollection,
  serializeWizard,
  validateStep,
  wizardReducer,
  wizardStepLabels,
  type WizardAction,
  type WizardState,
} from '@/lib/collection-wizard';
import { connectorChoiceLabel } from '@/lib/connector-choice';
import { useConnectors, useCreateCollection, useCustodians, useUpload } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatBytes } from '@/lib/format';

const STORAGE_KEY = 'cdfir-collection-wizard-v2';
/** Pre-upload persisted payloads; migrated (or discarded) on first load. */
const LEGACY_STORAGE_KEY = 'cdfir-collection-wizard-v1';

const MS_CONTENT_TYPES = [
  { value: 'Audit.Exchange', label: 'Exchange' },
  { value: 'Audit.SharePoint', label: 'SharePoint' },
  { value: 'Audit.AzureActiveDirectory', label: 'Entra ID (Azure AD)' },
  { value: 'Audit.General', label: 'General' },
  { value: 'DLP.All', label: 'DLP' },
] as const;

const GOOGLE_REPORT_APPS = [
  'login',
  'drive',
  'admin',
  'token',
  'mobile',
  'user_accounts',
  'groups',
  'saml',
] as const;

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export default function NewCollectionPage() {
  const router = useRouter();
  const [state, setState] = useState<WizardState>(() => freshWizard(newIdempotencyKey()));
  const [hydrated, setHydrated] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const create = useCreateCollection();

  // Resume from sessionStorage after mount (refresh-safe). v1 payloads are
  // migrated by hydrateWizard; the legacy key is cleaned up either way.
  useEffect(() => {
    const raw =
      window.sessionStorage.getItem(STORAGE_KEY) ??
      window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    setState((s) => hydrateWizard(raw, s.idempotencyKey));
    setHydrated(true);
  }, []);

  // Persist on every change so refresh resumes mid-wizard.
  useEffect(() => {
    if (hydrated) window.sessionStorage.setItem(STORAGE_KEY, serializeWizard(state));
  }, [state, hydrated]);

  const dispatch = useCallback((action: WizardAction) => {
    setState((s) => wizardReducer(s, action));
  }, []);

  const errors = validateStep(state, state.step);

  function next() {
    if (!canAdvance(state)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    dispatch({ type: 'next' });
  }

  function back() {
    setShowErrors(false);
    dispatch({ type: 'back' });
  }

  function start() {
    // The idempotency key was generated once when this wizard began and is
    // stored in the persisted state, so a retry reuses the same key.
    let body;
    try {
      body = buildCreateRequest(state);
    } catch (err) {
      setShowErrors(true);
      create.reset();
      // Surface a readable validation failure.
      console.error(err);
      return;
    }
    create.mutate(body, {
      onSuccess: (data) => {
        window.sessionStorage.removeItem(STORAGE_KEY);
        router.push(`/collections/${data.id}`);
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <h1>New collection</h1>
        <Link href="/collections">Back to collections</Link>
      </div>

      <Stepper
        label="Collection wizard progress"
        steps={wizardStepLabels(state)}
        current={state.step}
        onStepSelect={(step) => dispatch({ type: 'goto', step })}
      />

      {showErrors && errors.length > 0 ? (
        <div role="alert" className="cdfir-notice cdfir-notice--warning">
          <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <StepBody state={state} dispatch={dispatch} />

      <div className="wizard-actions">
        <Button variant="secondary" onClick={back} disabled={state.step === 0}>
          Back
        </Button>
        {state.step < STEP_START ? (
          <Button onClick={next}>Next</Button>
        ) : (
          <Button onClick={start} busy={create.isPending}>
            Start collection
          </Button>
        )}
      </div>

      <StatusLive politeness="assertive">
        {create.isError ? `Could not start collection: ${errorMessage(create.error)}` : ''}
      </StatusLive>
    </>
  );
}

function StepBody({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: (a: WizardAction) => void;
}) {
  const upload = isUploadCollection(state);
  switch (state.step) {
    case 0:
      return <ProviderStep state={state} dispatch={dispatch} />;
    case 1:
      return upload ? (
        <UploadStep state={state} dispatch={dispatch} />
      ) : (
        <AccountStep state={state} dispatch={dispatch} />
      );
    case 2:
      return <SourcesStep state={state} dispatch={dispatch} />;
    case 3:
      return upload ? (
        <UploadCustodianStep state={state} dispatch={dispatch} />
      ) : (
        <CustodiansStep state={state} dispatch={dispatch} />
      );
    case 4:
      return <ScopeStep state={state} dispatch={dispatch} />;
    case 5:
      return <TypeStep state={state} dispatch={dispatch} />;
    case 6:
      return <ReviewStep state={state} />;
    case 7:
      return <StartStep state={state} />;
    default:
      return null;
  }
}

type StepProps = { state: WizardState; dispatch: (a: WizardAction) => void };

function ProviderStep({ state, dispatch }: StepProps) {
  return (
    <section aria-label="Step 1: provider">
      <TextInput
        label="Collection name"
        hint="A descriptive name for reports and manifests, e.g. “Acme v. Foo — mailbox sweep”."
        value={state.name}
        onChange={(e) => dispatch({ type: 'patch', patch: { name: e.target.value } })}
      />
      <RadioGroup
        legend="Provider"
        name="provider"
        value={state.provider}
        onChange={(value) => {
          const provider = value as WizardState['provider'];
          dispatch({
            type: 'patch',
            patch: {
              provider,
              connectorAccountId: '',
              connectorMode: '',
              custodians: [],
              // Uploads are always snapshot email collections.
              ...(provider === 'upload'
                ? {
                    sources: { email: true, drive: false, audit: false },
                    kind: 'snapshot' as const,
                  }
                : {}),
            },
          });
        }}
        options={[
          {
            value: 'microsoft',
            label: 'Microsoft 365',
            description: 'Exchange Online mail, OneDrive',
          },
          { value: 'google', label: 'Google Workspace', description: 'Gmail, Google Drive' },
          {
            value: 'imap',
            label: 'IMAP mailbox',
            description: 'Yahoo, iCloud, AOL, or any mail server — mail only, no drive',
          },
          {
            value: 'upload',
            label: 'PST / mailbox file upload',
            description: 'Preserve and review Outlook data files (.pst, .ost)',
          },
        ]}
      />
    </section>
  );
}

function AccountStep({ state, dispatch }: StepProps) {
  const connectors = useConnectors();
  return (
    <section aria-label="Step 2: account">
      <QueryBoundary
        isPending={connectors.isPending}
        error={connectors.error}
        data={connectors.data}
        onRetry={() => void connectors.refetch()}
      >
        {(data) => {
          const usable = data.items.filter((c) => c.provider === state.provider);
          if (usable.length === 0)
            return (
              <Notice variant="warning">
                No {state.provider} connectors are configured.{' '}
                <Link href="/connectors">Connect an account</Link> first, then return here — your
                progress is saved.
              </Notice>
            );
          return (
            <RadioGroup
              legend="Connected account to collect through"
              name="connector"
              value={state.connectorAccountId}
              onChange={(value) => {
                const chosen = usable.find((c) => c.id === value);
                dispatch({
                  type: 'patch',
                  patch: {
                    connectorAccountId: value,
                    connectorMode: (chosen?.mode ?? '') as WizardState['connectorMode'],
                    custodians: [],
                  },
                });
              }}
              options={usable.map((c) => ({
                value: c.id,
                // Disambiguated when two connectors reach the same mailbox.
                label: connectorChoiceLabel(c, usable),
                description:
                  c.mode === 'organization'
                    ? 'Corporate account — collects any permitted user in the tenant via admin-consented app access.'
                    : 'Personal connection — collects only what this identity can access.',
              }))}
            />
          );
        }}
      </QueryBoundary>
    </section>
  );
}

// --- Upload path (provider 'upload') ---

interface ActiveUpload {
  filename: string;
  size: number;
  /** 0..1 */
  progress: number;
}

interface UploadFailure {
  filename: string;
  message: string;
}

function UploadStep({ state, dispatch }: StepProps) {
  const upload = useUpload();
  const [active, setActive] = useState<ActiveUpload | null>(null);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const [statusText, setStatusText] = useState('');

  async function uploadSequentially(files: File[]) {
    setFailures([]);
    for (const file of files) {
      if (!/\.(pst|ost)$/i.test(file.name)) {
        setFailures((prev) => [
          ...prev,
          { filename: file.name, message: 'Only .pst and .ost files are accepted.' },
        ]);
        continue;
      }
      setActive({ filename: file.name, size: file.size, progress: 0 });
      setStatusText(`Uploading ${file.name}…`);
      try {
        const result = await upload.mutateAsync({
          file,
          onProgress: (fraction) =>
            setActive((a) => (a === null ? a : { ...a, progress: fraction })),
        });
        dispatch({ type: 'addUpload', upload: result });
        setStatusText(`${file.name} uploaded and preserved.`);
      } catch (err) {
        const message = errorMessage(err);
        setFailures((prev) => [...prev, { filename: file.name, message }]);
        setStatusText(`Upload of ${file.name} failed: ${message}`);
      }
    }
    setActive(null);
  }

  return (
    <section aria-label="Step 2: upload mailbox files">
      <Notice variant="info">{PST_EXTRACTION_NOTICE}</Notice>

      <TextInput
        label="Mailbox files (.pst, .ost)"
        hint="Files upload one at a time and are hashed and preserved on receipt. You can add more files afterwards."
        type="file"
        accept=".pst,.ost"
        multiple
        disabled={active !== null}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          void uploadSequentially(files);
        }}
      />

      {active !== null ? (
        <ProgressBar
          label={`Uploading ${active.filename}`}
          value={Math.round(active.progress * 100)}
          max={100}
          detail={`${active.filename} · ${formatBytes(active.size)}`}
        />
      ) : null}
      <StatusLive>{statusText}</StatusLive>

      {failures.length > 0 ? (
        <div role="alert" className="cdfir-notice cdfir-notice--warning">
          <ul style={{ margin: 0, paddingInlineStart: '1.2em' }}>
            {failures.map((f, i) => (
              <li key={`${f.filename}-${i}`}>
                {f.filename}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.uploads.length > 0 ? (
        <>
          <Table caption={`Uploaded files (${state.uploads.length})`}>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">SHA-256</th>
                <th scope="col">
                  <VisuallyHidden>Actions</VisuallyHidden>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.uploads.map((u) => (
                <tr key={u.uploadId}>
                  <td style={{ overflowWrap: 'anywhere' }}>{u.filename}</td>
                  <td>{formatBytes(u.size)}</td>
                  <td>
                    <span className="mono" title={u.sha256}>
                      {u.sha256.slice(0, 16)}…
                    </span>
                  </td>
                  <td>
                    <Button
                      small
                      variant="secondary"
                      aria-label={`Remove ${u.filename} from this collection`}
                      onClick={() => dispatch({ type: 'removeUpload', uploadId: u.uploadId })}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="cdfir-field__hint">
            Removing a file here only excludes it from this collection. The preserved upload itself
            remains in the evidence store.
          </p>
        </>
      ) : (
        <p>No files uploaded yet.</p>
      )}
    </section>
  );
}

function UploadCustodianStep({ state, dispatch }: StepProps) {
  return (
    <section aria-label="Step 4: custodians">
      <p>
        Uploaded mailbox files carry no connected account, so name the custodian yourself: all
        messages extracted from the container(s) will be attributed to this custodian in search,
        review, exports, and reports.
      </p>
      <TextInput
        label="Custodian email"
        hint="The mailbox owner’s address, e.g. alice@acme.example."
        type="email"
        autoComplete="off"
        value={state.uploadCustodian.email}
        onChange={(e) =>
          dispatch({
            type: 'patch',
            patch: { uploadCustodian: { ...state.uploadCustodian, email: e.target.value } },
          })
        }
      />
      <TextInput
        label="Display name (optional)"
        hint="Shown alongside the email where custodians are listed."
        autoComplete="off"
        value={state.uploadCustodian.displayName}
        onChange={(e) =>
          dispatch({
            type: 'patch',
            patch: { uploadCustodian: { ...state.uploadCustodian, displayName: e.target.value } },
          })
        }
      />
    </section>
  );
}

function SourcesStep({ state, dispatch }: StepProps) {
  if (isUploadCollection(state)) {
    return (
      <section aria-label="Step 3: sources">
        <Notice variant="info">
          Uploaded mailbox files contain email only, so the email source is selected automatically.
          Drive and audit-log sources do not apply to uploads.
        </Notice>
      </section>
    );
  }
  const auditNeedsOrg = state.sources.audit && state.connectorMode !== 'organization';
  return (
    <section aria-label="Step 3: sources">
      <fieldset className="cdfir-fieldset">
        <legend>Data sources</legend>
        <Checkbox
          label="Email"
          checked={state.sources.email}
          onChange={(e) =>
            dispatch({
              type: 'patch',
              patch: { sources: { ...state.sources, email: e.target.checked } },
            })
          }
        />
        {/* A mailbox has no drive and no provider audit log. Disabling these is
            clearer than letting them be ticked and then failing validation. */}
        <Checkbox
          label="Drive files"
          checked={state.sources.drive}
          disabled={state.provider === 'imap'}
          hint={state.provider === 'imap' ? 'Not available: IMAP is mail only.' : undefined}
          onChange={(e) =>
            dispatch({
              type: 'patch',
              patch: { sources: { ...state.sources, drive: e.target.checked } },
            })
          }
        />
        <Checkbox
          label="Audit logs (organization-wide)"
          checked={state.sources.audit}
          disabled={state.provider === 'imap'}
          hint={
            state.provider === 'imap' ? 'Not available: IMAP has no provider audit log.' : undefined
          }
          onChange={(e) =>
            dispatch({
              type: 'patch',
              patch: { sources: { ...state.sources, audit: e.target.checked } },
            })
          }
        />
      </fieldset>
      {state.provider === 'imap' ? (
        <Notice variant="info">
          IMAP collects mail only. Every selectable mailbox is walked by UID, and the original
          message bytes are preserved exactly as the server returns them.
        </Notice>
      ) : null}
      {state.sources.audit ? (
        <Notice variant={auditNeedsOrg ? 'warning' : 'info'}>
          Audit logs are collected for the whole organization (app permission / domain-wide
          delegation), not per custodian.{' '}
          {auditNeedsOrg ? (
            <>
              This connector is not in organization mode.{' '}
              <Link href="/connectors">Connect an organization account</Link> or deselect audit
              logs.
            </>
          ) : null}
        </Notice>
      ) : null}
    </section>
  );
}

function CustodiansStep({ state, dispatch }: StepProps) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Debounce directory searches (live-directory lookups are rate-limited).
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const custodians = useCustodians(state.connectorAccountId, search);
  const delegated = state.connectorMode === 'delegated';
  const auditOnly = isAuditOnly(state);

  // Delegated connections collect for the signed-in identity only.
  useEffect(() => {
    const self = custodians.data?.pages[0]?.items[0];
    if (!auditOnly && delegated && state.custodians.length === 0 && self) {
      dispatch({ type: 'patch', patch: { custodians: [{ id: self.id, email: self.email }] } });
    }
  }, [auditOnly, delegated, custodians.data, state.custodians.length, dispatch]);

  // Audit-only collections are organization-scoped: no custodian to choose.
  if (auditOnly) {
    return (
      <section aria-label="Step 4: custodians">
        <Notice variant="info">
          This is an audit-log collection. Audit logs are organization-wide, so there is no
          custodian to select — collection runs against the whole tenant’s audit feeds.
        </Notice>
      </section>
    );
  }

  if (delegated) {
    return (
      <section aria-label="Step 4: custodians">
        <TruthNotice kind="delegatedAccess" />
        {state.custodians[0] ? (
          <p>
            Custodian: <strong>{state.custodians[0].email}</strong> (the connected identity — fixed
            for personally connected accounts).
          </p>
        ) : (
          <p role="status" aria-live="polite">
            Resolving the connected identity…
          </p>
        )}
      </section>
    );
  }

  const selectedIds = new Set(state.custodians.map((c) => c.id));

  return (
    <section aria-label="Step 4: custodians">
      <TextInput
        label="Search custodians"
        hint="Live directory search by name or email — any permitted user in the tenant can be selected."
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />
      <QueryBoundary
        isPending={custodians.isPending}
        error={custodians.error}
        data={custodians.data}
        onRetry={() => void custodians.refetch()}
      >
        {(data) => {
          const results = data.pages.flatMap((page) => page.items);
          return (
            <>
              <fieldset className="cdfir-fieldset">
                <legend>Directory results</legend>
                {results.length === 0 ? <p>No matches.</p> : null}
                {results.map((c) => (
                  <Checkbox
                    key={c.id}
                    label={`${c.displayName ? `${c.displayName} — ` : ''}${c.email}`}
                    checked={selectedIds.has(c.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...state.custodians, { id: c.id, email: c.email }]
                        : state.custodians.filter((x) => x.id !== c.id);
                      dispatch({ type: 'patch', patch: { custodians: next } });
                    }}
                  />
                ))}
              </fieldset>
              {custodians.hasNextPage ? (
                <Button
                  small
                  variant="secondary"
                  busy={custodians.isFetchingNextPage}
                  onClick={() => void custodians.fetchNextPage()}
                >
                  Load more results
                </Button>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
      <p aria-live="polite">
        Selected ({state.custodians.length}):{' '}
        {state.custodians.map((c) => c.email).join(', ') || 'none'}
      </p>
    </section>
  );
}

function ScopeStep({ state, dispatch }: StepProps) {
  const timezones = useMemo(() => {
    const list = Intl.supportedValuesOf('timeZone');
    return list.includes('UTC') ? list : ['UTC', ...list];
  }, []);
  const s = state.scope;

  if (isUploadCollection(state)) {
    return (
      <section aria-label="Step 5: scope">
        <Notice variant="info">
          Scope is fixed for uploaded mailbox files: every item in each container is extracted — all
          folders, all dates. Date-range filtering for uploads is not available in this version.
        </Notice>
      </section>
    );
  }

  return (
    <section aria-label="Step 5: scope">
      <RadioGroup
        legend="Date scope"
        name="dateKind"
        value={s.dateKind}
        onChange={(value) =>
          dispatch({ type: 'patchScope', patch: { dateKind: value as 'all_time' | 'range' } })
        }
        options={[
          { value: 'all_time', label: 'All time' },
          { value: 'range', label: 'Date range' },
        ]}
      />
      {s.dateKind === 'all_time' ? <TruthNotice kind="allTimeScope" /> : null}
      {s.dateKind === 'range' ? (
        <>
          <TextInput
            label="Start date (inclusive)"
            type="date"
            value={s.startDate}
            onChange={(e) => dispatch({ type: 'patchScope', patch: { startDate: e.target.value } })}
          />
          <TextInput
            label="End date (inclusive)"
            type="date"
            value={s.endDate}
            onChange={(e) => dispatch({ type: 'patchScope', patch: { endDate: e.target.value } })}
          />
          <Select
            label="Timezone for interpreting the dates"
            hint="An explicit IANA timezone is required; ambiguous abbreviations like PST are not accepted."
            value={s.timezone}
            placeholder="Choose a timezone…"
            onChange={(e) => dispatch({ type: 'patchScope', patch: { timezone: e.target.value } })}
            options={timezones.map((tz) => ({ value: tz, label: tz }))}
          />
        </>
      ) : null}

      {state.sources.email ? (
        <fieldset className="cdfir-fieldset">
          <legend>Email scope</legend>
          <Checkbox
            label="All discovered folders"
            checked={s.emailAllFolders}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { emailAllFolders: e.target.checked } })
            }
          />
          {!s.emailAllFolders ? (
            <TextArea
              label="Folder include list"
              hint="One folder id or path per line (or comma-separated)."
              rows={4}
              value={s.emailFolderIdsText}
              onChange={(e) =>
                dispatch({ type: 'patchScope', patch: { emailFolderIdsText: e.target.value } })
              }
            />
          ) : null}
          <Checkbox
            label="Include spam / junk"
            checked={s.includeSpam}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { includeSpam: e.target.checked } })
            }
          />
          <Checkbox
            label="Include trash / deleted items"
            checked={s.includeTrash}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { includeTrash: e.target.checked } })
            }
          />
          <Checkbox
            label="Include recoverable items (where the API exposes them)"
            checked={s.includeRecoverableItems}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { includeRecoverableItems: e.target.checked } })
            }
          />
        </fieldset>
      ) : null}

      {state.sources.drive ? (
        <fieldset className="cdfir-fieldset">
          <legend>Drive scope</legend>
          <Checkbox
            label="Default drive (all roots)"
            checked={s.driveAllRoots}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { driveAllRoots: e.target.checked } })
            }
          />
          {!s.driveAllRoots ? (
            <TextArea
              label="Drive root ids"
              hint="One drive/root id per line (or comma-separated)."
              rows={4}
              value={s.driveRootIdsText}
              onChange={(e) =>
                dispatch({ type: 'patchScope', patch: { driveRootIdsText: e.target.value } })
              }
            />
          ) : null}
          <Checkbox
            label="Include shared drives"
            checked={s.includeSharedDrives}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { includeSharedDrives: e.target.checked } })
            }
          />
          <Checkbox
            label="Include trashed items"
            checked={s.includeTrashed}
            onChange={(e) =>
              dispatch({ type: 'patchScope', patch: { includeTrashed: e.target.checked } })
            }
          />
          {state.provider === 'google' ? <TruthNotice kind="googleNativeExports" /> : null}
        </fieldset>
      ) : null}

      {state.sources.audit ? <AuditScopeFields state={state} dispatch={dispatch} /> : null}
    </section>
  );
}

function AuditScopeFields({ state, dispatch }: StepProps) {
  const a = state.scope.audit;
  return (
    <fieldset className="cdfir-fieldset">
      <legend>Audit-log scope</legend>
      <TruthNotice kind="auditScope" />

      {state.provider === 'microsoft' ? (
        <>
          <p>Office 365 Management Activity content types</p>
          {MS_CONTENT_TYPES.map((ct) => (
            <Checkbox
              key={ct.value}
              label={ct.label}
              checked={a.msContentTypes.includes(ct.value)}
              onChange={(e) =>
                dispatch({
                  type: 'patchAudit',
                  patch: { msContentTypes: toggle(a.msContentTypes, ct.value, e.target.checked) },
                })
              }
            />
          ))}
          <Checkbox
            label="Include Graph sign-in logs"
            checked={a.includeGraphSignins}
            onChange={(e) =>
              dispatch({ type: 'patchAudit', patch: { includeGraphSignins: e.target.checked } })
            }
          />
          <Checkbox
            label="Include Graph directory audits"
            checked={a.includeGraphDirectoryAudits}
            onChange={(e) =>
              dispatch({
                type: 'patchAudit',
                patch: { includeGraphDirectoryAudits: e.target.checked },
              })
            }
          />
        </>
      ) : null}

      {state.provider === 'google' ? (
        <>
          <p>Admin SDK Reports applications</p>
          {GOOGLE_REPORT_APPS.map((app) => (
            <Checkbox
              key={app}
              label={app}
              checked={a.googleReportApplications.includes(app)}
              onChange={(e) =>
                dispatch({
                  type: 'patchAudit',
                  patch: {
                    googleReportApplications: toggle(
                      a.googleReportApplications,
                      app,
                      e.target.checked,
                    ),
                  },
                })
              }
            />
          ))}
          <Checkbox
            label="Include Google Vault (matters / exports — metadata only)"
            checked={a.includeVault}
            onChange={(e) =>
              dispatch({ type: 'patchAudit', patch: { includeVault: e.target.checked } })
            }
          />
          {a.includeVault ? (
            <TextArea
              label="Vault matter ids (optional)"
              hint="One matter id per line (or comma-separated). Leave blank for all accessible matters."
              rows={3}
              value={a.vaultMatterIdsText}
              onChange={(e) =>
                dispatch({ type: 'patchAudit', patch: { vaultMatterIdsText: e.target.value } })
              }
            />
          ) : null}
        </>
      ) : null}

      <TextArea
        label="Actor filter (optional)"
        hint="Restrict to specific actor principals (UPN/email), one per line or comma-separated, where the provider supports it."
        rows={2}
        value={a.actorFilterText}
        onChange={(e) =>
          dispatch({ type: 'patchAudit', patch: { actorFilterText: e.target.value } })
        }
      />
    </fieldset>
  );
}

function TypeStep({ state, dispatch }: StepProps) {
  const upload = isUploadCollection(state);
  return (
    <section aria-label="Step 6: collection type">
      <RadioGroup
        legend="Collection type"
        name="kind"
        value={state.kind}
        onChange={(value) =>
          dispatch({ type: 'patch', patch: { kind: value as 'snapshot' | 'continuous' } })
        }
        options={[
          {
            value: 'snapshot',
            label: 'Snapshot',
            description: 'One-time acquisition of everything in scope.',
          },
          {
            value: 'continuous',
            label: 'Continuous',
            description: upload
              ? 'Not available for uploaded mailbox files — a container is a fixed point-in-time file.'
              : 'Snapshot first, then ongoing incremental preservation.',
            disabled: upload,
          },
        ]}
      />
    </section>
  );
}

function ReviewStep({ state }: { state: WizardState }) {
  const s = state.scope;
  const upload = isUploadCollection(state);
  return (
    <section aria-label="Step 7: review">
      <Table caption="Collection summary">
        <tbody className="definition-table">
          <tr>
            <th scope="row">Name</th>
            <td>{state.name || '—'}</td>
          </tr>
          <tr>
            <th scope="row">Provider / mode</th>
            <td>
              {upload
                ? 'PST / mailbox file upload'
                : `${state.provider || '—'} (${state.connectorMode || '—'})`}
            </td>
          </tr>
          {upload ? (
            <tr>
              <th scope="row">Uploaded files</th>
              <td>
                {state.uploads.length === 0
                  ? '—'
                  : `${state.uploads.length} file(s): ${state.uploads
                      .map((u) => u.filename)
                      .join(', ')}`}
              </td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Sources</th>
            <td>
              {upload
                ? 'email (extracted from the uploaded containers)'
                : [
                    state.sources.email ? 'email' : null,
                    state.sources.drive ? 'drive' : null,
                    state.sources.audit ? 'audit logs' : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || '—'}
            </td>
          </tr>
          <tr>
            <th scope="row">Custodians</th>
            <td>
              {upload
                ? state.uploadCustodian.email
                  ? `${
                      state.uploadCustodian.displayName
                        ? `${state.uploadCustodian.displayName} — `
                        : ''
                    }${state.uploadCustodian.email}`
                  : '—'
                : state.custodians.map((c) => c.email).join(', ') || '—'}
            </td>
          </tr>
          <tr>
            <th scope="row">Date scope</th>
            <td>
              {upload
                ? 'All items in the uploaded container(s) — extraction covers the whole file'
                : s.dateKind === 'all_time'
                  ? 'All time (within account, permission, and API-visible scope)'
                  : `${s.startDate} to ${s.endDate} (${s.timezone})`}
            </td>
          </tr>
          <tr>
            <th scope="row">Type</th>
            <td>{state.kind}</td>
          </tr>
          <tr>
            <th scope="row">Estimated scope</th>
            <td>Item counts will be discovered at start; no estimate is promised in advance.</td>
          </tr>
        </tbody>
      </Table>

      <h2>Permissions, retention, and limitations</h2>
      {upload ? <Notice variant="info">{PST_EXTRACTION_NOTICE}</Notice> : null}
      {!upload && state.connectorMode === 'delegated' ? (
        <TruthNotice kind="delegatedAccess" />
      ) : null}
      {!upload && s.dateKind === 'all_time' ? <TruthNotice kind="allTimeScope" /> : null}
      {state.provider === 'google' && state.sources.drive ? (
        <TruthNotice kind="googleNativeExports" />
      ) : null}
      {!upload && state.sources.audit ? <TruthNotice kind="auditScope" /> : null}
      <TruthNotice kind="exceptions" variant="warning" />
    </section>
  );
}

function StartStep({ state }: { state: WizardState }) {
  return (
    <section aria-label="Step 8: start">
      <p>
        {isUploadCollection(state) ? (
          <>
            Starting will queue verification and message extraction for{' '}
            <strong>{state.uploads.length}</strong> uploaded container(s), attributed to{' '}
            <strong>{state.uploadCustodian.email}</strong>. Progress is visible on the collection
            status page.
          </>
        ) : isAuditOnly(state) ? (
          <>
            Starting will queue organization-wide audit-log discovery and preservation. Progress is
            visible on the collection status page.
          </>
        ) : (
          <>
            Starting will queue discovery and preservation for{' '}
            <strong>{state.custodians.length}</strong> custodian(s)
            {state.sources.audit ? ' plus organization-wide audit logs' : ''}. Progress is visible
            on the collection status page, per custodian and per source.
          </>
        )}
      </p>
      <Notice variant="info">
        This start request carries a stable idempotency key, so retrying after a network failure
        will not create a duplicate collection.
      </Notice>
    </section>
  );
}
