'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Select,
  Skeleton,
  StatusLive,
  Table,
  Tabs,
  Tag,
  TextInput,
  VisuallyHidden,
} from '@aeg-clouddfir/ui';
import { HighlightText, QueryBoundary, TruthNotice } from '@/components/shared';
import {
  useAuditRecords,
  useBulkTag,
  useCases,
  useCreateTag,
  useEvidence,
  useEvidencePreview,
  useExplain,
  useSaveSearch,
  useSavedSearches,
  useSearch,
  useTags,
} from '@/lib/hooks';
import type { SearchHit } from '@/lib/schemas';
import { QUERY_EXAMPLES } from '@/lib/query-help';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDateTime, humanizeToken } from '@/lib/format';

interface Filters {
  queryText: string;
  caseId: string;
  custodianEmail: string;
  source: string;
  facetFilters: Record<string, string[]>;
}

const EMPTY_FILTERS: Filters = {
  queryText: '',
  caseId: '',
  custodianEmail: '',
  source: '',
  facetFilters: {},
};

export default function ReviewPage() {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [submitted, setSubmitted] = useState<Filters | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<SearchHit[]>([]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');

  const search = useSearch(
    {
      queryText: submitted?.queryText ?? '',
      ...(submitted?.caseId ? { caseId: submitted.caseId } : {}),
      ...(submitted?.custodianEmail ? { custodianEmail: submitted.custodianEmail } : {}),
      ...(submitted?.source ? { source: submitted.source } : {}),
      facetFilters: submitted?.facetFilters ?? {},
      cursor,
    },
    submitted !== null,
  );

  // Accumulate pages (dedup by id) so the virtualized list grows on load-more.
  useEffect(() => {
    const page = search.data;
    if (!page) return;
    setItems((prev) => {
      const base = cursor === null ? [] : prev;
      const seen = new Set(base.map((i) => i.id));
      return [...base, ...page.items.filter((i) => !seen.has(i.id))];
    });
    setStatusText(`${page.total} result${page.total === 1 ? '' : 's'} found.`);
  }, [search.data, cursor]);

  function runSearch(filters: Filters) {
    setSubmitted(filters);
    setCursor(null);
    setSelection(new Set());
    setActiveId(null);
  }

  return (
    <>
      <h1>Review workspace</h1>
      <StatusLive politeness="polite">{statusText}</StatusLive>
      <div className="review-layout">
        <SearchRail
          draft={draft}
          setDraft={setDraft}
          onSearch={() => runSearch(draft)}
          onShowAll={() => {
            setDraft(EMPTY_FILTERS);
            runSearch(EMPTY_FILTERS);
          }}
          facets={search.data?.facets ?? []}
          submitted={submitted}
          onFacetToggle={(field, value, checked) => {
            if (!submitted) return;
            const current = submitted.facetFilters[field] ?? [];
            const nextValues = checked ? [...current, value] : current.filter((v) => v !== value);
            const next = {
              ...submitted,
              facetFilters: { ...submitted.facetFilters, [field]: nextValues },
            };
            setDraft(next);
            runSearch(next);
          }}
          onLoadSaved={(queryText, caseId) => {
            const next = { ...EMPTY_FILTERS, queryText, caseId };
            setDraft(next);
            runSearch(next);
          }}
        />

        <ResultsPane
          items={items}
          total={search.data?.total ?? 0}
          nextCursor={search.data?.nextCursor ?? null}
          isPending={submitted !== null && search.isPending}
          error={search.error}
          onRetry={() => void search.refetch()}
          hasSearched={submitted !== null}
          selection={selection}
          setSelection={setSelection}
          activeId={activeId}
          setActiveId={setActiveId}
          onLoadMore={() => setCursor(search.data?.nextCursor ?? null)}
          onStatus={setStatusText}
        />

        <PreviewPane
          activeId={activeId}
          queryText={submitted?.queryText ?? ''}
          onStatus={setStatusText}
        />
      </div>
    </>
  );
}

// --- Left rail ---

function SearchRail(props: {
  draft: Filters;
  setDraft: (f: Filters) => void;
  onShowAll: () => void;
  onSearch: () => void;
  facets: Array<{ field: string; label: string; values: Array<{ value: string; count: number }> }>;
  submitted: Filters | null;
  onFacetToggle: (field: string, value: string, checked: boolean) => void;
  onLoadSaved: (queryText: string, caseId: string) => void;
}) {
  const { draft, setDraft } = props;
  const cases = useCases();
  const savedSearches = useSavedSearches();
  const saveSearch = useSaveSearch();
  const [helpOpen, setHelpOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  return (
    <div className="review-rail">
      <form
        role="search"
        aria-label="Evidence search"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSearch();
        }}
      >
        <TextInput
          label="Search query"
          value={draft.queryText}
          onChange={(e) => setDraft({ ...draft, queryText: e.target.value })}
        />
        <div className="help-popover">
          <button
            type="button"
            className="cdfir-button cdfir-button--ghost cdfir-button--small"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((o) => !o)}
          >
            Query language help
          </button>
          {helpOpen ? (
            <div className="help-popover__panel">
              <ul>
                {QUERY_EXAMPLES.map((ex) => (
                  <li key={ex.query}>
                    <code>{ex.query}</code> — {ex.description}
                  </li>
                ))}
              </ul>
              <TruthNotice kind="bcc" />
            </div>
          ) : null}
        </div>

        <Select
          label="Case"
          value={draft.caseId}
          placeholder="All cases"
          onChange={(e) => setDraft({ ...draft, caseId: e.target.value })}
          options={(cases.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextInput
          label="Custodian filter"
          hint="Exact custodian email."
          value={draft.custodianEmail}
          onChange={(e) => setDraft({ ...draft, custodianEmail: e.target.value })}
        />
        <Select
          label="Source"
          value={draft.source}
          placeholder="All sources"
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          options={[
            { value: 'email', label: 'Email' },
            { value: 'drive', label: 'Drive' },
          ]}
        />
        <div className="button-row">
          <Button type="submit">Search</Button>
          <Button variant="secondary" onClick={props.onShowAll}>
            Show all
          </Button>
          <Button
            variant="secondary"
            disabled={props.submitted === null || draft.queryText.trim().length === 0}
            onClick={() => setSaveOpen(true)}
          >
            Save current
          </Button>
        </div>
      </form>

      {props.facets.length > 0 ? (
        <section aria-label="Result facets">
          {props.facets.map((facet) => (
            <div className="facet-group" key={facet.field}>
              <h3>{facet.label || humanizeToken(facet.field)}</h3>
              {facet.values.map((v) => (
                <Checkbox
                  key={v.value}
                  label={`${v.value} (${v.count})`}
                  checked={(props.submitted?.facetFilters[facet.field] ?? []).includes(v.value)}
                  onChange={(e) => props.onFacetToggle(facet.field, v.value, e.target.checked)}
                />
              ))}
            </div>
          ))}
        </section>
      ) : null}

      <section aria-label="Saved searches">
        <h3>Saved searches</h3>
        {savedSearches.isPending ? <Skeleton lines={2} label="Loading saved searches" /> : null}
        {savedSearches.data && savedSearches.data.items.length === 0 ? (
          <p className="cdfir-field__hint">None yet.</p>
        ) : null}
        <ul style={{ paddingInlineStart: '1.2em' }}>
          {(savedSearches.data?.items ?? []).map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="cdfir-button cdfir-button--ghost cdfir-button--small"
                onClick={() => props.onLoadSaved(s.queryText, s.caseId ?? '')}
              >
                {s.name}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save current search"
        actions={
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={saveName.trim().length === 0}
              busy={saveSearch.isPending}
              onClick={() =>
                saveSearch.mutate(
                  {
                    name: saveName.trim(),
                    ...(draft.caseId ? { caseId: draft.caseId } : {}),
                    queryText: draft.queryText,
                    queryAst: null,
                  },
                  { onSuccess: () => setSaveOpen(false) },
                )
              }
            >
              Save search
            </Button>
          </>
        }
      >
        <TextInput label="Name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
        {saveSearch.isError ? (
          <p role="alert" className="cdfir-field__error">
            {errorMessage(saveSearch.error)}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

// --- Center results ---

function ResultsPane(props: {
  items: SearchHit[];
  total: number;
  nextCursor: string | null;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  hasSearched: boolean;
  selection: ReadonlySet<string>;
  setSelection: (s: ReadonlySet<string>) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  onLoadMore: () => void;
  onStatus: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
  });

  function toggle(index: number, checked: boolean, shiftKey: boolean) {
    const next = new Set(props.selection);
    const apply = (i: number) => {
      const item = props.items[i];
      if (!item) return;
      if (checked) next.add(item.id);
      else next.delete(item.id);
    };
    if (shiftKey && lastIndexRef.current !== null) {
      const [from, to] = [
        Math.min(lastIndexRef.current, index),
        Math.max(lastIndexRef.current, index),
      ];
      for (let i = from; i <= to; i += 1) apply(i);
    } else {
      apply(index);
    }
    lastIndexRef.current = index;
    props.setSelection(next);
  }

  if (!props.hasSearched) {
    return (
      <div className="review-results" style={{ padding: 'var(--space-4)' }}>
        <EmptyState
          title="Search to begin review"
          description="Enter a query in the search rail, or choose “Show all” to browse the entire collected corpus (newest first)."
        />
      </div>
    );
  }

  return (
    <div className="review-results">
      <BulkTagBar
        selection={props.selection}
        onClear={() => props.setSelection(new Set())}
        onStatus={props.onStatus}
      />
      {props.error != null ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <EmptyState
            title="Search failed"
            description={errorMessage(props.error)}
            action={<Button onClick={props.onRetry}>Retry</Button>}
          />
        </div>
      ) : props.isPending && props.items.length === 0 ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <Skeleton label="Searching" lines={6} />
        </div>
      ) : props.items.length === 0 ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <EmptyState
            title="No results"
            description="Try broadening the query or clearing facets."
          />
        </div>
      ) : (
        <>
          <p style={{ padding: '0 var(--space-3)' }}>
            Showing {props.items.length} of {props.total} results
          </p>
          <div className="review-results__scroll" ref={scrollRef}>
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              role="list"
              aria-label="Search results"
            >
              {virtualizer.getVirtualItems().map((row) => {
                const item = props.items[row.index];
                if (!item) return null;
                const checked = props.selection.has(item.id);
                return (
                  <div
                    key={item.id}
                    role="listitem"
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    className={checked ? 'result-row result-row--selected' : 'result-row'}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${row.start}px)`,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      aria-label={`Select ${item.name}`}
                      onClick={(e) => toggle(row.index, !checked, e.shiftKey)}
                      onChange={() => undefined}
                    />
                    <span
                      aria-hidden="true"
                      title={item.familyRole !== 'none' ? `family ${item.familyRole}` : ''}
                    >
                      {item.familyRole === 'parent' ? '⌂' : item.familyRole === 'child' ? '↳' : ''}
                    </span>
                    <div>
                      {item.familyRole !== 'none' ? (
                        <VisuallyHidden>Family {item.familyRole}.</VisuallyHidden>
                      ) : null}
                      <button
                        type="button"
                        className="result-row__name"
                        onClick={() => props.setActiveId(item.id)}
                      >
                        {item.name || '(no subject)'}
                      </button>
                      <div className="result-row__meta">
                        {item.custodianEmail ?? 'unknown custodian'} ·{' '}
                        {formatDateTime(item.primaryDate)} · {item.sourcePath} ·{' '}
                        {item.extension || item.mimeType} · {formatBytes(item.size)}
                      </div>
                      {item.highlights[0] ? (
                        <div className="result-row__meta">
                          <HighlightText snippet={item.highlights[0]} />
                        </div>
                      ) : null}
                      <div>
                        {item.tags.map((t) => (
                          <Tag key={t.id} name={t.name} color={t.color} />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {props.nextCursor ? (
            <div className="button-row" style={{ padding: '0 var(--space-3)' }}>
              <Button variant="secondary" onClick={props.onLoadMore} busy={props.isPending}>
                Load more results
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function BulkTagBar({
  selection,
  onClear,
  onStatus,
}: {
  selection: ReadonlySet<string>;
  onClear: () => void;
  onStatus: (text: string) => void;
}) {
  const tags = useTags();
  const bulkTag = useBulkTag();
  const [tagId, setTagId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  if (selection.size === 0) return null;

  function run(action: 'apply' | 'remove') {
    if (!tagId) return;
    bulkTag.mutate(
      { tagId, evidenceItemIds: [...selection], action },
      {
        onSuccess: () =>
          onStatus(
            `Tag ${action === 'apply' ? 'applied to' : 'removed from'} ${selection.size} item(s).`,
          ),
        onError: (err) => onStatus(errorMessage(err)),
      },
    );
  }

  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <strong>{selection.size} selected</strong>
      <label>
        <VisuallyHidden>Tag to apply or remove</VisuallyHidden>
        <select className="cdfir-select" value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">Choose tag…</option>
          {(tags.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <Button small disabled={!tagId} busy={bulkTag.isPending} onClick={() => run('apply')}>
        Apply tag
      </Button>
      <Button
        small
        variant="secondary"
        disabled={!tagId}
        busy={bulkTag.isPending}
        onClick={() => run('remove')}
      >
        Remove tag
      </Button>
      <Button small variant="ghost" onClick={() => setCreateOpen(true)}>
        New tag…
      </Button>
      <Button small variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
      <CreateTagDialog open={createOpen} onClose={() => setCreateOpen(false)} onStatus={onStatus} />
    </div>
  );
}

function CreateTagDialog({
  open,
  onClose,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  onStatus: (text: string) => void;
}) {
  const createTag = useCreateTag();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1d4ed8');
  const [description, setDescription] = useState('');
  const [isPrivileged, setIsPrivileged] = useState(false);
  const [isConfidential, setIsConfidential] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [familyBehavior, setFamilyBehavior] = useState('none');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create tag"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length === 0}
            busy={createTag.isPending}
            onClick={() =>
              createTag.mutate(
                {
                  name: name.trim(),
                  color,
                  description,
                  isPrivileged,
                  isConfidential,
                  isHidden,
                  familyBehavior,
                },
                {
                  onSuccess: () => {
                    onStatus(`Tag “${name.trim()}” created.`);
                    onClose();
                  },
                },
              )
            }
          >
            Create tag
          </Button>
        </>
      }
    >
      <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <TextInput
        label="Color"
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
      />
      <TextInput
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Checkbox
        label="Privileged"
        checked={isPrivileged}
        onChange={(e) => setIsPrivileged(e.target.checked)}
      />
      <Checkbox
        label="Confidential"
        checked={isConfidential}
        onChange={(e) => setIsConfidential(e.target.checked)}
      />
      <Checkbox
        label="Hidden (visible only to case managers and admins)"
        checked={isHidden}
        onChange={(e) => setIsHidden(e.target.checked)}
      />
      <Select
        label="Family behavior"
        value={familyBehavior}
        onChange={(e) => setFamilyBehavior(e.target.value)}
        options={[
          { value: 'none', label: 'Tag only the item' },
          { value: 'apply_to_family', label: 'Apply to the whole family' },
          { value: 'apply_to_descendants', label: 'Apply to descendants' },
        ]}
      />
      {createTag.isError ? (
        <p role="alert" className="cdfir-field__error">
          {errorMessage(createTag.error)}
        </p>
      ) : null}
    </Dialog>
  );
}

// --- Right preview pane ---

function PreviewPane({
  activeId,
  queryText,
  onStatus,
}: {
  activeId: string | null;
  queryText: string;
  onStatus: (text: string) => void;
}) {
  const evidence = useEvidence(activeId);
  const preview = useEvidencePreview(activeId);
  const [explainOpen, setExplainOpen] = useState(false);
  const explain = useExplain(queryText, explainOpen ? activeId : null);

  if (activeId === null) {
    return (
      <div className="review-preview">
        <EmptyState title="No item selected" description="Choose a result to preview it here." />
      </div>
    );
  }

  return (
    <div className="review-preview">
      <QueryBoundary
        isPending={evidence.isPending}
        error={evidence.error}
        data={evidence.data}
        onRetry={() => void evidence.refetch()}
      >
        {(item) => (
          <>
            <h2 style={{ marginTop: 0, overflowWrap: 'anywhere' }}>{item.name}</h2>
            {item.isApiExportDerivative ? <TruthNotice kind="googleNativeExports" /> : null}
            <div className="button-row">
              <Button
                small
                variant="secondary"
                aria-expanded={explainOpen}
                onClick={() => setExplainOpen((o) => !o)}
              >
                Why this matched
              </Button>
            </div>
            {explainOpen ? (
              <section aria-label="Match explanation" className="help-popover__panel">
                {explain.isPending ? (
                  <Skeleton lines={2} label="Loading match explanation" />
                ) : explain.data && explain.data.matches.length > 0 ? (
                  <ul>
                    {explain.data.matches.map((m, i) => (
                      <li key={i}>
                        <strong>{m.field}</strong>: <HighlightText snippet={m.fragment} />{' '}
                        {m.reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No explanation available for this item and query.</p>
                )}
              </section>
            ) : null}
            <Tabs
              label="Evidence detail"
              tabs={[
                {
                  id: 'content',
                  label: 'Content',
                  panel: <ContentTab previewState={preview} />,
                },
                ...((item.kind as string) === 'audit_batch'
                  ? [{ id: 'audit', label: 'Audit', panel: <AuditTab itemId={item.id} /> }]
                  : []),
                {
                  id: 'metadata',
                  label: 'Metadata',
                  panel: (
                    <Table caption="Item metadata" captionHidden>
                      <tbody>
                        <tr>
                          <th scope="row">Kind</th>
                          <td>{item.kind}</td>
                        </tr>
                        <tr>
                          <th scope="row">Custodian</th>
                          <td>{item.custodianEmail ?? '—'}</td>
                        </tr>
                        <tr>
                          <th scope="row">Path</th>
                          <td className="mono">{item.sourcePath}</td>
                        </tr>
                        <tr>
                          <th scope="row">Primary date</th>
                          <td>{formatDateTime(item.primaryDate)}</td>
                        </tr>
                        <tr>
                          <th scope="row">Size</th>
                          <td>{formatBytes(item.size)}</td>
                        </tr>
                        <tr>
                          <th scope="row">SHA-256</th>
                          <td className="mono">{item.sha256}</td>
                        </tr>
                        <tr>
                          <th scope="row">Processing</th>
                          <td>{item.processingStatus}</td>
                        </tr>
                        <tr>
                          <th scope="row">Malware scan</th>
                          <td>{item.malwareStatus}</td>
                        </tr>
                        {Object.entries(item.metadata).map(([k, v]) => (
                          <tr key={k}>
                            <th scope="row">{k}</th>
                            <td className="mono">
                              {typeof v === 'string' ? v : JSON.stringify(v)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ),
                },
                {
                  id: 'headers',
                  label: 'Raw headers',
                  panel:
                    item.headers.length === 0 ? (
                      <p>No headers for this item.</p>
                    ) : (
                      <Table caption="Raw message headers" captionHidden>
                        <tbody>
                          {item.headers.map((h, i) => (
                            <tr key={`${h.name}-${i}`}>
                              <th scope="row" className="mono">
                                {h.name}
                              </th>
                              <td className="mono">{h.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ),
                },
                {
                  id: 'text',
                  label: 'Text / OCR',
                  panel: item.extractedText ? (
                    <pre className="preview-pre">{item.extractedText}</pre>
                  ) : (
                    <p>No extracted text.</p>
                  ),
                },
                {
                  id: 'family',
                  label: 'Family',
                  panel:
                    item.family.length === 0 ? (
                      <p>This item has no family members.</p>
                    ) : (
                      <ul>
                        {item.family.map((f) => (
                          <li key={f.id}>
                            {f.relationship}: {f.name} ({f.kind})
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  id: 'versions',
                  label: 'Versions',
                  panel:
                    item.versions.length === 0 ? (
                      <p>No preserved versions.</p>
                    ) : (
                      <Table caption="Preserved versions" captionHidden>
                        <thead>
                          <tr>
                            <th scope="col">Version</th>
                            <th scope="col">Modified</th>
                            <th scope="col">SHA-256</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.versions.map((v) => (
                            <tr key={v.id}>
                              <td>{v.versionLabel}</td>
                              <td>{formatDateTime(v.modifiedAt)}</td>
                              <td className="mono">{v.sha256.slice(0, 16)}…</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ),
                },
                {
                  id: 'custody',
                  label: 'Chain of custody',
                  panel:
                    item.custody.length === 0 ? (
                      <p>No custody events recorded.</p>
                    ) : (
                      <ol>
                        {item.custody.map((c) => (
                          <li key={c.sequence}>
                            {formatDateTime(c.occurredAt)} — {humanizeToken(c.action)} by{' '}
                            {c.actorDisplay}{' '}
                            <span className="mono">({c.eventHash.slice(0, 12)}…)</span>
                          </li>
                        ))}
                      </ol>
                    ),
                },
                {
                  id: 'tags',
                  label: 'Tags & notes',
                  panel: <TagsTab itemId={item.id} tags={item.tags} onStatus={onStatus} />,
                },
                {
                  id: 'productions',
                  label: 'Production history',
                  panel:
                    item.productionHistory.length === 0 ? (
                      <p>Never produced.</p>
                    ) : (
                      <Table caption="Production history" captionHidden>
                        <thead>
                          <tr>
                            <th scope="col">Production</th>
                            <th scope="col">Bates range</th>
                            <th scope="col">Produced</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.productionHistory.map((p) => (
                            <tr key={p.productionId}>
                              <td>{p.productionName}</td>
                              <td className="mono">
                                {p.batesStart}
                                {p.batesEnd && p.batesEnd !== p.batesStart ? `–${p.batesEnd}` : ''}
                              </td>
                              <td>{formatDateTime(p.producedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ),
                },
              ]}
            />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function ContentTab({ previewState }: { previewState: ReturnType<typeof useEvidencePreview> }) {
  if (previewState.isPending) return <Skeleton label="Loading preview" lines={4} />;
  if (previewState.error != null)
    return <p role="alert">Preview unavailable: {errorMessage(previewState.error)}</p>;
  const preview = previewState.data;
  if (!preview || preview.kind === 'none')
    return <p>No safe preview is available for this item.</p>;
  if (preview.kind === 'safe_html') {
    // sandbox="" (fully restrictive): no scripts, no same-origin, no forms.
    return (
      <iframe
        className="preview-frame"
        sandbox=""
        srcDoc={preview.content}
        title="Sanitized evidence preview"
      />
    );
  }
  return <pre className="preview-pre">{preview.content}</pre>;
}

function AuditTab({ itemId }: { itemId: string }) {
  const records = useAuditRecords(itemId, true);
  if (records.isPending) return <Skeleton label="Loading audit records" lines={6} />;
  if (records.error != null)
    return <p role="alert">Audit records unavailable: {errorMessage(records.error)}</p>;
  const data = records.data;
  if (!data || data.items.length === 0) return <p>No audit records in this batch.</p>;
  return (
    <>
      <p>
        {data.items.length} record(s){data.nextCursor ? ' (first page)' : ''} in this batch.
      </p>
      <div className="table-scroll">
        <Table caption="Audit records" captionHidden>
          <thead>
            <tr>
              <th scope="col">Occurred</th>
              <th scope="col">Actor</th>
              <th scope="col">Workload</th>
              <th scope="col">Operation</th>
              <th scope="col">Result</th>
              <th scope="col">IP</th>
              <th scope="col">Target</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.occurredAt)}</td>
                <td>{r.actorEmail || r.actorId || '—'}</td>
                <td>{r.workload || '—'}</td>
                <td>{r.operation || '—'}</td>
                <td>{r.resultStatus || '—'}</td>
                <td className="mono">{r.actorIp || '—'}</td>
                <td>
                  {r.targetType || r.targetId ? (
                    <>
                      {r.targetType} <span className="mono">{r.targetId}</span>
                    </>
                  ) : (
                    '—'
                  )}
                  <details>
                    <summary>Raw event</summary>
                    <pre className="preview-pre">{JSON.stringify(r.raw, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}

function TagsTab({
  itemId,
  tags,
  onStatus,
}: {
  itemId: string;
  tags: Array<{ id: string; name: string; color: string }>;
  onStatus: (text: string) => void;
}) {
  const allTags = useTags();
  const bulkTag = useBulkTag();
  const [tagId, setTagId] = useState('');
  const [note, setNote] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const available = useMemo(
    () => (allTags.data?.items ?? []).filter((t) => !tags.some((x) => x.id === t.id)),
    [allTags.data, tags],
  );

  function mutate(action: 'apply' | 'remove', id: string) {
    bulkTag.mutate(
      {
        tagId: id,
        evidenceItemIds: [itemId],
        action,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          onStatus(action === 'apply' ? 'Tag applied.' : 'Tag removed.');
          setNote('');
        },
        onError: (err) => onStatus(errorMessage(err)),
      },
    );
  }

  return (
    <div>
      <h3>Current tags</h3>
      {tags.length === 0 ? <p>No tags.</p> : null}
      <div>
        {tags.map((t) => (
          <Tag key={t.id} name={t.name} color={t.color} onRemove={() => mutate('remove', t.id)} />
        ))}
      </div>
      <h3>Apply a tag</h3>
      <Select
        label="Tag"
        value={tagId}
        placeholder="Choose tag…"
        onChange={(e) => setTagId(e.target.value)}
        options={available.map((t) => ({ value: t.id, label: t.name }))}
      />
      <TextInput
        label="Note (optional, recorded with the tag action)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="button-row">
        <Button
          small
          disabled={!tagId}
          busy={bulkTag.isPending}
          onClick={() => mutate('apply', tagId)}
        >
          Apply tag
        </Button>
        <Button small variant="ghost" onClick={() => setCreateOpen(true)}>
          New tag…
        </Button>
      </div>
      <CreateTagDialog open={createOpen} onClose={() => setCreateOpen(false)} onStatus={onStatus} />
    </div>
  );
}
