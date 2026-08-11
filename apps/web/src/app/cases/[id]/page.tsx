'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Checkbox,
  Select,
  Skeleton,
  StatusLive,
  Table,
  TextInput,
} from '@evidencevault/ui';
import { ConfirmDialog, QueryBoundary, StatusPill } from '@/components/shared';
import {
  useAddCaseItems,
  useAddCaseNote,
  useCase,
  useCaseMembers,
  useCaseNotes,
  useSavedSearches,
  useTags,
  useUpdateCase,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

export default function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const caseQuery = useCase(id);
  const update = useUpdateCase(id);
  const [holdConfirm, setHoldConfirm] = useState(false);
  const [statusText, setStatusText] = useState('');

  return (
    <>
      <div className="page-header">
        <h1>Case</h1>
        <Link href="/cases">All cases</Link>
      </div>
      <StatusLive politeness="polite">{statusText}</StatusLive>
      <QueryBoundary
        isPending={caseQuery.isPending}
        error={caseQuery.error}
        data={caseQuery.data}
        onRetry={() => void caseQuery.refetch()}
      >
        {(c) => (
          <>
            <div className="page-header">
              <h2 style={{ margin: 0 }}>{c.name}</h2>
              <StatusPill status={c.status} />
            </div>
            <p>
              Matter {c.matterNumber || '—'} · Client {c.client || '—'} · Created{' '}
              {formatDateTime(c.createdAt)}
            </p>
            {c.description ? <p>{c.description}</p> : null}

            <div className="button-row">
              <span className="pill" aria-hidden="true">
                {c.legalHold ? 'Legal hold: ON' : 'Legal hold: off'}
              </span>
              <Button
                variant={c.legalHold ? 'secondary' : 'danger'}
                onClick={() => setHoldConfirm(true)}
                busy={update.isPending}
              >
                {c.legalHold ? 'Release legal hold' : 'Place legal hold'}
              </Button>
            </div>

            <ConfirmDialog
              open={holdConfirm}
              title={c.legalHold ? 'Release legal hold' : 'Place legal hold'}
              body={
                <p>
                  {c.legalHold
                    ? 'Releasing the hold allows retention policies to apply again to referenced evidence.'
                    : 'Placing a hold suspends retention-driven deletion for evidence referenced by this case.'}{' '}
                  A reason is required and is written to the audit log.
                </p>
              }
              confirmLabel={c.legalHold ? 'Release hold' : 'Place hold'}
              destructive={c.legalHold}
              requireReason
              busy={update.isPending}
              onCancel={() => setHoldConfirm(false)}
              onConfirm={(reason) =>
                update.mutate(
                  { legalHold: !c.legalHold, reason, expectedVersion: c.version },
                  {
                    onSuccess: () => {
                      setStatusText(c.legalHold ? 'Legal hold released.' : 'Legal hold placed.');
                      setHoldConfirm(false);
                    },
                    onError: (err) => {
                      setStatusText(errorMessage(err));
                      setHoldConfirm(false);
                    },
                  },
                )
              }
            />

            <div className="card-grid" style={{ marginTop: 'var(--space-4)' }}>
              <AddItemsCard caseId={id} onStatus={setStatusText} />
              <MembersCard caseId={id} />
              <NotesCard caseId={id} onStatus={setStatusText} />
            </div>
          </>
        )}
      </QueryBoundary>
    </>
  );
}

function AddItemsCard({ caseId, onStatus }: { caseId: string; onStatus: (t: string) => void }) {
  const tags = useTags();
  const savedSearches = useSavedSearches();
  const addItems = useAddCaseItems(caseId);
  const [sourceKind, setSourceKind] = useState<'tag' | 'saved_search'>('tag');
  const [sourceId, setSourceId] = useState('');
  const [includeFamilies, setIncludeFamilies] = useState(true);

  const options =
    sourceKind === 'tag'
      ? (tags.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))
      : (savedSearches.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }));

  return (
    <section className="card" aria-labelledby="case-add-items">
      <h2 id="case-add-items">Add items to case</h2>
      <p className="ev-field__hint">
        Membership is reference-only: adding never copies or alters evidence.
      </p>
      <Select
        label="Add from"
        value={sourceKind}
        onChange={(e) => {
          setSourceKind(e.target.value as 'tag' | 'saved_search');
          setSourceId('');
        }}
        options={[
          { value: 'tag', label: 'Everything with a tag' },
          { value: 'saved_search', label: 'Results of a saved search' },
        ]}
      />
      <Select
        label={sourceKind === 'tag' ? 'Tag' : 'Saved search'}
        value={sourceId}
        placeholder="Choose…"
        onChange={(e) => setSourceId(e.target.value)}
        options={options}
      />
      <Checkbox
        label="Include family members"
        checked={includeFamilies}
        onChange={(e) => setIncludeFamilies(e.target.checked)}
      />
      <Button
        disabled={!sourceId}
        busy={addItems.isPending}
        onClick={() =>
          addItems.mutate(
            {
              source:
                sourceKind === 'tag'
                  ? { kind: 'tag', tagId: sourceId }
                  : { kind: 'saved_search', savedSearchId: sourceId },
              includeFamilies,
            },
            {
              onSuccess: () => onStatus('Items queued to be added to the case.'),
              onError: (err) => onStatus(errorMessage(err)),
            },
          )
        }
      >
        Add to case
      </Button>
    </section>
  );
}

function MembersCard({ caseId }: { caseId: string }) {
  const members = useCaseMembers(caseId);
  return (
    <section className="card" aria-labelledby="case-members">
      <h2 id="case-members">Members</h2>
      <QueryBoundary
        isPending={members.isPending}
        error={members.error}
        data={members.data}
        onRetry={() => void members.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <p>No members assigned. Tenant admins manage case membership.</p>
          ) : (
            <Table caption="Case members" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Roles</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.membershipId}>
                    <td>{m.displayName || m.email}</td>
                    <td>{m.roles.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
    </section>
  );
}

function NotesCard({ caseId, onStatus }: { caseId: string; onStatus: (t: string) => void }) {
  const notes = useCaseNotes(caseId);
  const addNote = useAddCaseNote(caseId);
  const [text, setText] = useState('');

  return (
    <section className="card" aria-labelledby="case-notes">
      <h2 id="case-notes">Notes</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length === 0) return;
          addNote.mutate(text.trim(), {
            onSuccess: () => {
              setText('');
              onStatus('Note added.');
            },
            onError: (err) => onStatus(errorMessage(err)),
          });
        }}
      >
        <TextInput label="Add a note" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" small busy={addNote.isPending} disabled={text.trim().length === 0}>
          Add note
        </Button>
      </form>
      {notes.isPending ? <Skeleton lines={2} label="Loading notes" /> : null}
      <ul>
        {(notes.data?.items ?? []).map((n) => (
          <li key={n.id}>
            <strong>{n.authorDisplay}</strong> ({formatDateTime(n.createdAt)}): {n.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
