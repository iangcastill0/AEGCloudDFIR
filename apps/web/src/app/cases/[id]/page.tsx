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
} from '@aeg-clouddfir/ui';
import { ConfirmDialog, QueryBoundary, StatusPill } from '@/components/shared';
import {
  useAddCaseItems,
  useAddCaseNote,
  useCase,
  useCaseActivity,
  useCaseSummary,
  useCaseMembers,
  useCaseNotes,
  useCollections,
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
              <ContentsCard caseId={id} />
              <ActivityCard caseId={id} />
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

/**
 * What the case actually contains.
 *
 * Counted by the database, not by paging through items in the browser: a case
 * can reference tens of thousands. Collections and custodians are named, because
 * "which acquisition does this matter draw on" is the question a reviewer
 * actually has.
 */
function ContentsCard({ caseId }: { caseId: string }) {
  const summary = useCaseSummary(caseId);
  return (
    <section className="card" aria-labelledby="case-contents">
      <h2 id="case-contents">What is in this case</h2>
      <QueryBoundary
        isPending={summary.isPending}
        error={summary.error}
        data={summary.data}
        onRetry={() => void summary.refetch()}
      >
        {(s) =>
          s.itemCount === 0 ? (
            <p className="cdfir-field__hint">
              No items yet. Add some below — a collection is usually the place to start.
            </p>
          ) : (
            <>
              <p>
                <strong>{s.itemCount.toLocaleString()}</strong> item
                {s.itemCount === 1 ? '' : 's'} · {s.noteCount} note{s.noteCount === 1 ? '' : 's'} ·{' '}
                {s.memberCount} member{s.memberCount === 1 ? '' : 's'}
              </p>
              {s.earliestItemDate && s.latestItemDate ? (
                <p className="cdfir-field__hint">
                  {/* The evidence's own dates, not when it was added: that is what
                      scopes a matter. */}
                  Evidence dated {formatDateTime(s.earliestItemDate)} to{' '}
                  {formatDateTime(s.latestItemDate)}
                </p>
              ) : null}

              <h3>By type</h3>
              <ul className="cdfir-count-list">
                {s.byKind.map((k) => (
                  <li key={k.kind}>
                    <span>{k.kind}</span>
                    <span>{k.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>

              <h3>How it got here</h3>
              <ul className="cdfir-count-list">
                {s.bySource.map((v) => (
                  <li key={v.addedVia}>
                    <span>{v.addedVia}</span>
                    <span>{v.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>

              {s.collections.length > 0 ? (
                <>
                  <h3>From collections</h3>
                  <ul className="cdfir-count-list">
                    {s.collections.map((c) => (
                      <li key={c.id}>
                        <Link href={`/collections/${c.id}`}>{c.name}</Link>
                        <span>{c.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {s.custodians.length > 0 ? (
                <>
                  <h3>Custodians</h3>
                  <ul className="cdfir-count-list">
                    {s.custodians.map((c) => (
                      <li key={c.id}>
                        <span>{c.email}</span>
                        <span>{c.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )
        }
      </QueryBoundary>
    </section>
  );
}

/**
 * The case's history, taken from the hash-chained audit log.
 *
 * Scoped to this case, so someone working it can see what happened without the
 * tenant-wide audit permission. Each line is described by the API rather than
 * assembled here: the audit summary is free-form JSON, and a browser guessing at
 * its shape is how "undefined items added" reaches a screen.
 */
function ActivityCard({ caseId }: { caseId: string }) {
  const activity = useCaseActivity(caseId);
  return (
    <section className="card" aria-labelledby="case-activity">
      <h2 id="case-activity">Activity</h2>
      <QueryBoundary
        isPending={activity.isPending}
        error={activity.error}
        data={activity.data}
        onRetry={() => void activity.refetch()}
      >
        {(a) =>
          a.items.length === 0 ? (
            <p className="cdfir-field__hint">Nothing recorded yet.</p>
          ) : (
            <Table caption="Case activity" captionHidden>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                </tr>
              </thead>
              <tbody>
                {a.items.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.occurredAt)}</td>
                    <td>{e.actorDisplay || '—'}</td>
                    <td>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
      <p className="cdfir-field__hint">
        {/* Say where this comes from: it is the same append-only chain the audit
            tab verifies, not a separate log that could disagree with it. */}
        From the append-only audit chain. Verify it under Audit.
      </p>
    </section>
  );
}

type SourceKind = 'collection' | 'tag' | 'saved_search';

function AddItemsCard({ caseId, onStatus }: { caseId: string; onStatus: (t: string) => void }) {
  const tags = useTags();
  const savedSearches = useSavedSearches();
  const collections = useCollections();
  const addItems = useAddCaseItems(caseId);
  const [sourceKind, setSourceKind] = useState<SourceKind>('collection');
  const [sourceId, setSourceId] = useState('');
  const [includeFamilies, setIncludeFamilies] = useState(true);

  const options =
    sourceKind === 'tag'
      ? (tags.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))
      : sourceKind === 'saved_search'
        ? (savedSearches.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))
        : // Show what the collection holds: picking by name alone gives no clue
          // whether it is the one that acquired 6 items or 6,000.
          (collections.data?.items ?? []).map((c) => ({
            value: c.id,
            label: `${c.name} (${c.status})`,
          }));

  return (
    <section className="card" aria-labelledby="case-add-items">
      <h2 id="case-add-items">Add items to case</h2>
      <p className="cdfir-field__hint">
        Membership is reference-only: adding never copies or alters evidence.
      </p>
      <Select
        label="Add from"
        value={sourceKind}
        onChange={(e) => {
          setSourceKind(e.target.value as SourceKind);
          setSourceId('');
        }}
        options={[
          // First, because it is how a matter usually starts: collect, then
          // scope the case to what came back.
          { value: 'collection', label: 'Everything in a collection' },
          { value: 'tag', label: 'Everything with a tag' },
          { value: 'saved_search', label: 'Results of a saved search' },
        ]}
      />
      <Select
        label={
          sourceKind === 'tag'
            ? 'Tag'
            : sourceKind === 'saved_search'
              ? 'Saved search'
              : 'Collection'
        }
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
                  : sourceKind === 'saved_search'
                    ? { kind: 'saved_search', savedSearchId: sourceId }
                    : { kind: 'collection', collectionId: sourceId },
              includeFamilies,
            },
            {
              // Report the counts the API returns. "Queued" was both vague and
              // wrong — the add is synchronous and already done — and it read the
              // same whether 500 items were added or none.
              onSuccess: (result) => {
                if (result.added === 0) {
                  onStatus(
                    result.requested === 0
                      ? 'Nothing matched that selection, so no items were added.'
                      : `No new items added \u2014 all ${String(result.requested)} were already in the case.`,
                  );
                  return;
                }
                const already = result.requested - result.added;
                onStatus(
                  already > 0
                    ? `Added ${String(result.added)} item(s). ${String(already)} were already in the case.`
                    : `Added ${String(result.added)} item(s) to the case.`,
                );
              },
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
