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
import { API_URL } from '@/lib/api';
import {
  buildBashScript,
  buildHashesTxt,
  buildPowerShellScript,
  recommendScript,
  saveExportToFolder,
  supportsDirectoryPicker,
  type DownloadPlanInput,
  type FolderSaveProgress,
} from '@/lib/export-download';

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
                        <ExportDownload exportId={e.id} expiresAt={e.downloadExpiresAt} />
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
  const [kind, setKind] = useState<'native' | 'csv' | 'pst'>('native');
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
        onChange={(v) => setKind(v as 'native' | 'csv' | 'pst')}
        options={[
          { value: 'native', label: 'Native files', description: 'Original bytes plus manifest.' },
          { value: 'csv', label: 'CSV metadata', description: 'Chosen columns, one row per item.' },
          {
            value: 'pst',
            label: 'Outlook PST (email only)',
            // Said here, at the point of choosing, and not only in the finished
            // export. Someone who picks this needs to know before they wait
            // hours for it that the bytes inside are not the collected bytes.
            description:
              'Email re-encoded into Outlook mailbox files. A reconstruction, not natives — the native .eml digests ship alongside it.',
          },
        ]}
      />
      {/* The standing notice, verbatim, whenever PST is the chosen kind. */}
      {kind === 'pst' ? <TruthNotice kind="pstExport" variant="warning" /> : null}
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
 * Resolves an export's presigned URLs, then offers the right way to save them.
 *
 * The endpoint returns an envelope, not a file, so this cannot be a plain link.
 *
 * Which way is "right" depends on size, because a browser cannot make a folder
 * from a download — path separators are stripped from both the `download`
 * attribute and the Content-Disposition filename. A small export is streamed
 * into a folder the user picks; a large one gets a script, which resumes a
 * broken part and does not need a tab open for hours.
 *
 * The manifest and its SHA-256 stay visible on every path. They are what make
 * the download verifiable, and burying them behind a convenient button would
 * hide the one artifact a recipient needs.
 */
function ExportDownload({ exportId, expiresAt }: { exportId: string; expiresAt: string | null }) {
  const download = useExportDownload();
  const links = download.data;
  const [saving, setSaving] = useState<FolderSaveProgress | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  if (links) {
    const plan: DownloadPlanInput = {
      exportId,
      folderName: links.folderName,
      manifestUrl: links.manifestUrl,
      manifestSha256: links.manifestSha256,
      parts: links.parts,
      downloadToken: links.downloadToken,
      apiBaseUrl: API_URL,
    };
    const useScript = recommendScript(links.parts);
    const canPickFolder = supportsDirectoryPicker();
    const unverifiable = links.parts.filter((p) => p.sha256 === null).length;

    return (
      <div className="cdfir-downloads">
        <span className="cdfir-field__hint">
          {`${String(links.parts.length)} part(s) \u2192 ${links.folderName}/`}
        </span>

        {useScript ? (
          <span className="cdfir-field__hint">
            This export is large enough that a browser tab is the wrong tool. The script resumes a
            broken part and refreshes its own links.
          </span>
        ) : null}

        <a href={textFileUrl(buildBashScript(plan))} download={`download-${links.folderName}.sh`}>
          Download script (macOS / Linux)
        </a>
        <a
          href={textFileUrl(buildPowerShellScript(plan))}
          download={`download-${links.folderName}.ps1`}
        >
          Download script (Windows)
        </a>
        <a
          href={textFileUrl(buildHashesTxt(links.parts, links.manifestSha256))}
          download="hashes.txt"
        >
          hashes.txt
        </a>

        {canPickFolder ? (
          <Button
            type="button"
            variant="secondary"
            disabled={saving !== null}
            onClick={() => {
              setSaveError('');
              setSaved(false);
              void saveExportToFolder(plan, setSaving)
                .then(() => {
                  setSaved(true);
                })
                .catch((err: unknown) => {
                  setSaveError(errorMessage(err));
                })
                .finally(() => {
                  setSaving(null);
                });
            }}
          >
            {saving === null ? 'Save to folder\u2026' : 'Saving\u2026'}
          </Button>
        ) : (
          <span className="cdfir-field__hint">
            Saving straight to a folder needs Chrome or Edge. Use the script above instead.
          </span>
        )}

        {saving !== null ? (
          <span className="cdfir-field__hint">
            {`Saving ${saving.filename} (${String(saving.done + 1)} of ${String(saving.total)})\u2026`}
          </span>
        ) : null}
        {saved ? <span className="cdfir-field__hint">Saved. Verify with hashes.txt.</span> : null}
        {saveError !== '' ? <span className="cdfir-field__error">{saveError}</span> : null}

        <a href={links.manifestUrl}>Download manifest</a>
        <span className="cdfir-field__hint">manifest sha256, to verify the archive:</span>
        <span className="cdfir-downloads__hash">{links.manifestSha256}</span>
        {unverifiable > 0 ? (
          <span className="cdfir-field__error">
            {`${String(unverifiable)} part(s) have no recorded digest and cannot be checked against hashes.txt. Verify their contents after extracting instead.`}
          </span>
        ) : null}
        <span className="cdfir-field__hint">
          {`Links expire in ${String(Math.round(links.expiresInSeconds / 60))} min. Both the script and "Save to folder" refresh their own as they go, so a long download does not need reopening. The plain links above go stale.`}
        </span>
      </div>
    );
  }

  return (
    <div className="cdfir-downloads">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          download.mutate(exportId);
        }}
        disabled={download.isPending}
      >
        {download.isPending ? 'Preparing\u2026' : 'Download'}
      </Button>
      {expiresAt ? (
        <span className="cdfir-field__hint">{`Available until ${formatDateTime(expiresAt)}`}</span>
      ) : null}
      {download.isError ? (
        <span className="cdfir-field__error">{errorMessage(download.error)}</span>
      ) : null}
    </div>
  );
}

/**
 * A data: URL for generated text.
 *
 * Deliberately not a blob: URL — those need revoking, and a leaked one would
 * outlive the component holding a download token in it.
 */
function textFileUrl(contents: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(contents)}`;
}
