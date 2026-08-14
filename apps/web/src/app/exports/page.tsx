'use client';
import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  RadioGroup,
  Select,
  StatusLive,
  Table,
  TextInput,
} from '@aeg-clouddfir/ui';
import { QueryBoundary, StatusPill, TruthNotice } from '@/components/shared';
import {
  useCases,
  useCreateExport,
  useExportDownload,
  useExports,
  useSavedSearches,
  useTags,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDateTime } from '@/lib/format';

const CSV_COLUMNS = [
  'evidence_id',
  'name',
  'custodian',
  'source_path',
  'primary_date',
  'mime_type',
  'size',
  'sha256',
  'tags',
  'collection',
  'bates_history',
];

export default function ExportsPage() {
  const exportsQuery = useExports();
  const [createOpen, setCreateOpen] = useState(false);
  const [statusText, setStatusText] = useState('');

  return (
    <>
      <div className="page-header">
        <h1>Exports</h1>
        <Button onClick={() => setCreateOpen(true)}>New export</Button>
      </div>
      <StatusLive politeness="polite">{statusText}</StatusLive>
      <QueryBoundary
        isPending={exportsQuery.isPending}
        error={exportsQuery.error}
        data={exportsQuery.data}
        onRetry={() => void exportsQuery.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No exports"
              description="Create a native or CSV export of a tag, saved search, or case."
              action={<Button onClick={() => setCreateOpen(true)}>Create an export</Button>}
            />
          ) : (
            <Table caption="Exports" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Items</th>
                  <th scope="col">Size</th>
                  <th scope="col">Verified</th>
                  <th scope="col">Download</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>{e.kind}</td>
                    <td>
                      <StatusPill status={e.status} />
                      {e.statusDetail ? (
                        <span className="cdfir-field__hint"> {e.statusDetail}</span>
                      ) : null}
                    </td>
                    <td>{e.itemCount}</td>
                    <td>{formatBytes(e.totalBytes)}</td>
                    <td>{formatDateTime(e.verifiedAt)}</td>
                    <td>
                      {e.status === 'ready' ? (
                        <ExportDownload
                          exportId={e.id}
                          expiresAt={e.downloadExpiresAt}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
      {createOpen ? (
        <CreateExportDialog onClose={() => setCreateOpen(false)} onStatus={setStatusText} />
      ) : null}
    </>
  );
}

function CreateExportDialog({
  onClose,
  onStatus,
}: {
  onClose: () => void;
  onStatus: (t: string) => void;
}) {
  const createExport = useCreateExport();
  const tags = useTags();
  const savedSearches = useSavedSearches();
  const cases = useCases();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'native' | 'csv'>('native');
  const [selectionKind, setSelectionKind] = useState<'tag' | 'saved_search' | 'case'>('tag');
  const [selectionId, setSelectionId] = useState('');
  const [includeFamilies, setIncludeFamilies] = useState(true);
  const [columns, setColumns] = useState<string[]>(['evidence_id', 'name', 'custodian', 'sha256']);
  const [delimiter, setDelimiter] = useState<',' | '\t'>(',');

  const selectionOptions =
    selectionKind === 'tag'
      ? (tags.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))
      : selectionKind === 'saved_search'
        ? (savedSearches.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))
        : (cases.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }));

  const valid =
    name.trim().length > 0 && selectionId.length > 0 && (kind !== 'csv' || columns.length > 0);

  function submit() {
    const selection =
      selectionKind === 'tag'
        ? { kind: 'tag', tagId: selectionId }
        : selectionKind === 'saved_search'
          ? { kind: 'saved_search', savedSearchId: selectionId }
          : { kind: 'case', caseId: selectionId };
    createExport.mutate(
      {
        idempotencyKey: crypto.randomUUID(),
        kind,
        name: name.trim(),
        selection,
        includeFamilies,
        ...(kind === 'csv' ? { csv: { columns, delimiter } } : {}),
      },
      {
        onSuccess: () => {
          onStatus('Export queued.');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New export"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} busy={createExport.isPending} onClick={submit}>
            Create export
          </Button>
        </>
      }
    >
      <TruthNotice kind="defensibility" variant="warning" />
      <TextInput label="Export name" value={name} onChange={(e) => setName(e.target.value)} />
      <RadioGroup
        legend="Export kind"
        name="export-kind"
        value={kind}
        onChange={(v) => setKind(v as 'native' | 'csv')}
        options={[
          { value: 'native', label: 'Native files', description: 'Original bytes plus manifest.' },
          { value: 'csv', label: 'CSV metadata', description: 'Chosen columns, one row per item.' },
        ]}
      />
      <Select
        label="Select items from"
        value={selectionKind}
        onChange={(e) => {
          setSelectionKind(e.target.value as typeof selectionKind);
          setSelectionId('');
        }}
        options={[
          { value: 'tag', label: 'Tag' },
          { value: 'saved_search', label: 'Saved search' },
          { value: 'case', label: 'Case' },
        ]}
      />
      <Select
        label={
          selectionKind === 'tag'
            ? 'Tag'
            : selectionKind === 'saved_search'
              ? 'Saved search'
              : 'Case'
        }
        value={selectionId}
        placeholder="Choose…"
        onChange={(e) => setSelectionId(e.target.value)}
        options={selectionOptions}
      />
      <Checkbox
        label="Include family members"
        checked={includeFamilies}
        onChange={(e) => setIncludeFamilies(e.target.checked)}
      />
      {kind === 'csv' ? (
        <>
          <fieldset className="cdfir-fieldset">
            <legend>CSV columns</legend>
            {CSV_COLUMNS.map((col) => (
              <Checkbox
                key={col}
                label={col}
                checked={columns.includes(col)}
                onChange={(e) =>
                  setColumns((prev) =>
                    e.target.checked ? [...prev, col] : prev.filter((c) => c !== col),
                  )
                }
              />
            ))}
          </fieldset>
          <Select
            label="Delimiter"
            value={delimiter === ',' ? 'comma' : 'tab'}
            onChange={(e) => setDelimiter(e.target.value === 'comma' ? ',' : '\t')}
            options={[
              { value: 'comma', label: 'Comma (,)' },
              { value: 'tab', label: 'Tab' },
            ]}
          />
        </>
      ) : null}
      {createExport.isError ? (
        <p role="alert" className="cdfir-field__error">
          {errorMessage(createExport.error)}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * Resolves an export's presigned URLs, then shows them.
 *
 * The endpoint returns an envelope, not a file, so this cannot be a plain link.
 * The parts are listed individually rather than auto-downloaded: an export can
 * be split into several archives, browsers block multiple programmatic
 * downloads, and — more importantly — the manifest and its SHA-256 are what
 * make the download verifiable. Hiding them behind an automatic save would bury
 * the one artifact a recipient needs to check the contents against.
 */
function ExportDownload({
  exportId,
  expiresAt,
}: {
  exportId: string;
  expiresAt: string | null;
}) {
  const download = useExportDownload();
  const links = download.data;

  if (links) {
    return (
      <div className="cdfir-fieldset">
        {/* No `download` attribute: browsers ignore it cross-origin, and these
            URLs point at the storage host. The attachment disposition is signed
            into the URL by the API instead. */}
        <a href={links.manifestUrl}>manifest.json</a>
        {links.archiveUrls.map((url, i) => (
          <a key={url} href={url}>
            {`part ${String(i + 1).padStart(3, '0')} of ${links.archiveUrls.length}`}
          </a>
        ))}
        <span className="cdfir-field__hint">
          manifest sha256 {links.manifestSha256}
        </span>
        <span className="cdfir-field__hint">
          {`links expire in ${String(links.expiresInSeconds)}s — reopen this to get fresh ones`}
        </span>
      </div>
    );
  }

  return (
    <div className="cdfir-fieldset">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          download.mutate(exportId);
        }}
        disabled={download.isPending}
      >
        {download.isPending ? 'Preparing…' : 'Download'}
      </Button>
      {expiresAt ? (
        <span className="cdfir-field__hint">{`expires ${formatDateTime(expiresAt)}`}</span>
      ) : null}
      {download.isError ? (
        <span className="cdfir-field__hint">{errorMessage(download.error)}</span>
      ) : null}
    </div>
  );
}
