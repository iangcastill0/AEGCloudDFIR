'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Notice,
  RadioGroup,
  Select,
  StatusLive,
  Stepper,
  TextInput,
} from '@aeg-clouddfir/ui';
import type { ProductionParameters } from '@aeg-clouddfir/contracts';
import {
  productionParameters,
  stampPosition,
  validateProductionResponse,
} from '@aeg-clouddfir/contracts';
import type { z } from 'zod';
import { TruthNotice } from '@/components/shared';
import {
  PRODUCTION_STEPS,
  canAdvanceProduction,
  formatBates,
  freshProductionWizard,
  productionWizardReducer,
  validateProductionStep,
  type ProductionWizardAction,
  type ProductionWizardState,
} from '@/lib/production-wizard';
import {
  useCaseTags,
  useCases,
  useCreateProduction,
  useMe,
  useSavedSearches,
  useSubmitProduction,
  useTags,
  useValidateProduction,
} from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

type ValidationResult = z.infer<typeof validateProductionResponse>;

const SECURITY_PHRASE = 'I UNDERSTAND THE RISK';

export default function NewProductionPage() {
  const router = useRouter();
  const [state, setState] = useState<ProductionWizardState>(() =>
    freshProductionWizard(crypto.randomUUID()),
  );
  const [showErrors, setShowErrors] = useState(false);
  const dispatch = (action: ProductionWizardAction) =>
    setState((s) => productionWizardReducer(s, action));

  // "Clone settings" handoff from a production detail page.
  useEffect(() => {
    const raw = window.sessionStorage.getItem('cdfir-production-clone-v1');
    if (!raw) return;
    window.sessionStorage.removeItem('cdfir-production-clone-v1');
    try {
      const cloned = productionParameters.safeParse(JSON.parse(raw));
      if (cloned.success) {
        setState((s) => ({
          ...s,
          parameters: { ...cloned.data, name: `${cloned.data.name} (copy)` },
        }));
      }
    } catch {
      // ignore malformed handoff
    }
  }, []);

  const errors = validateProductionStep(state, state.step);
  const lastStep = state.step === PRODUCTION_STEPS.length - 1;

  return (
    <>
      <div className="page-header">
        <h1>New production</h1>
        <Link href="/productions">All productions</Link>
      </div>
      <Stepper
        label="Production wizard progress"
        steps={[...PRODUCTION_STEPS]}
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

      <ProductionStepBody
        state={state}
        dispatch={dispatch}
        onDone={(id) => router.push(`/productions/${id}`)}
      />

      {!lastStep ? (
        <div className="wizard-actions">
          <Button
            variant="secondary"
            onClick={() => dispatch({ type: 'back' })}
            disabled={state.step === 0}
          >
            Back
          </Button>
          <Button
            onClick={() => {
              if (!canAdvanceProduction(state)) {
                setShowErrors(true);
                return;
              }
              setShowErrors(false);
              dispatch({ type: 'next' });
            }}
          >
            Next
          </Button>
        </div>
      ) : (
        <div className="wizard-actions">
          <Button variant="secondary" onClick={() => dispatch({ type: 'back' })}>
            Back
          </Button>
        </div>
      )}
    </>
  );
}

function ProductionStepBody({
  state,
  dispatch,
  onDone,
}: {
  state: ProductionWizardState;
  dispatch: (a: ProductionWizardAction) => void;
  onDone: (productionId: string) => void;
}) {
  const p = state.parameters;
  const patch = (patchValue: Partial<ProductionParameters>) =>
    dispatch({ type: 'patchParams', patch: patchValue });

  switch (state.step) {
    case 0:
      return <NameStep state={state} dispatch={dispatch} />;
    case 1:
      return <SelectionStep state={state} dispatch={dispatch} />;
    case 2:
      return <OutputStep p={p} patch={patch} />;
    case 3:
      return <NativesStep p={p} patch={patch} />;
    case 4:
      return (
        <Select
          label="Sort order"
          value={p.sort}
          onChange={(e) => patch({ sort: e.target.value as ProductionParameters['sort'] })}
          options={[
            { value: 'folder_filename', label: 'Folder, then filename' },
            { value: 'filename', label: 'Filename' },
            { value: 'primary_date_asc', label: 'Primary date (oldest first)' },
            { value: 'primary_date_desc', label: 'Primary date (newest first)' },
            { value: 'custodian', label: 'Custodian' },
            { value: 'evidence_id', label: 'Evidence id' },
          ]}
        />
      );
    case 5:
      return <StampsStep p={p} patch={patch} />;
    case 6:
      return <RedactionsStep p={p} patch={patch} />;
    case 7:
      return <BatesStep p={p} patch={patch} />;
    case 8:
      return (
        <RadioGroup
          legend="Produced filenames"
          name="filenames"
          value={p.filenames}
          onChange={(v) => patch({ filenames: v as ProductionParameters['filenames'] })}
          options={[
            { value: 'bates', label: 'Bates number only' },
            { value: 'original', label: 'Original filename' },
            { value: 'bates_original', label: 'Bates number + original filename' },
          ]}
        />
      );
    case 9:
      return <ValidateStep state={state} dispatch={dispatch} onDone={onDone} />;
    default:
      return null;
  }
}

function NameStep({
  state,
  dispatch,
}: {
  state: ProductionWizardState;
  dispatch: (a: ProductionWizardAction) => void;
}) {
  const cases = useCases();
  const p = state.parameters;
  return (
    <section aria-label="Step 1: name">
      <TextInput
        label="Production name"
        value={p.name}
        onChange={(e) => dispatch({ type: 'patchParams', patch: { name: e.target.value } })}
      />
      <TextInput
        label="Description"
        value={p.description}
        onChange={(e) => dispatch({ type: 'patchParams', patch: { description: e.target.value } })}
      />
      <Select
        label="Case (optional)"
        value={state.caseId}
        placeholder="No case"
        onChange={(e) => dispatch({ type: 'setCaseId', caseId: e.target.value })}
        options={(cases.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
      />
    </section>
  );
}

function SelectionStep({
  state,
  dispatch,
}: {
  state: ProductionWizardState;
  dispatch: (a: ProductionWizardAction) => void;
}) {
  // Scope the tag list to the case chosen in step 1. Offering every tenant
  // tag invites selecting one that matches nothing in the matter, which
  // produces an empty set — or worse, silently narrows a production the
  // reviewer believed was complete.
  const caseTags = useCaseTags(state.caseId);
  const allTags = useTags();
  const scopedToCase = state.caseId !== '';
  const tagOptions: { id: string; name: string; itemCount: number | null }[] = scopedToCase
    ? (caseTags.data?.items ?? [])
    : (allTags.data?.items ?? []).map((t) => ({ id: t.id, name: t.name, itemCount: null }));
  const tagsLoading = scopedToCase ? caseTags.isPending : allTags.isPending;
  const savedSearches = useSavedSearches();
  const p = state.parameters;
  const sel = p.selection;
  const patchSelection = (s: Partial<ProductionParameters['selection']>) =>
    dispatch({ type: 'patchParams', patch: { selection: { ...sel, ...s } } });

  return (
    <section aria-label="Step 2: selection">
      <fieldset className="cdfir-fieldset">
        <legend>Tags to produce</legend>
        <p className="cdfir-field__hint">
          {scopedToCase
            ? "Showing only tags that appear on this case's items."
            : 'No case selected, so every tag in the tenant is listed. Choose a case in step 1 to narrow this to the matter.'}
        </p>
        {tagOptions.map((t) => (
          <Checkbox
            key={t.id}
            label={
              t.itemCount === null
                ? t.name
                : `${t.name} (${String(t.itemCount)} item(s) in this case)`
            }
            checked={sel.tagIds.includes(t.id)}
            onChange={(e) =>
              patchSelection({
                tagIds: e.target.checked
                  ? [...sel.tagIds, t.id]
                  : sel.tagIds.filter((x) => x !== t.id),
              })
            }
          />
        ))}
        {!tagsLoading && tagOptions.length === 0 ? (
          <p>
            {scopedToCase
              ? 'No tagged items in this case yet. Tag items in review, or add tagged items to the case first.'
              : 'No tags exist yet.'}
          </p>
        ) : null}
      </fieldset>
      <fieldset className="cdfir-fieldset">
        <legend>Saved searches to produce</legend>
        {(savedSearches.data?.items ?? []).map((s) => (
          <Checkbox
            key={s.id}
            label={s.name}
            checked={sel.savedSearchIds.includes(s.id)}
            onChange={(e) =>
              patchSelection({
                savedSearchIds: e.target.checked
                  ? [...sel.savedSearchIds, s.id]
                  : sel.savedSearchIds.filter((x) => x !== s.id),
              })
            }
          />
        ))}
        {savedSearches.data && savedSearches.data.items.length === 0 ? (
          <p>No saved searches yet.</p>
        ) : null}
      </fieldset>
      <Checkbox
        label="Invert selection (produce everything NOT matched)"
        checked={sel.inverted}
        onChange={(e) => patchSelection({ inverted: e.target.checked })}
      />
      <Checkbox
        label="Include family members"
        checked={sel.includeFamilies}
        onChange={(e) => patchSelection({ includeFamilies: e.target.checked })}
      />
      <RadioGroup
        legend="Previously produced items"
        name="exclude-produced"
        value={sel.excludePreviouslyProduced.kind}
        onChange={(v) =>
          patchSelection({
            excludePreviouslyProduced: v === 'none' ? { kind: 'none' } : { kind: 'any_earlier' },
          })
        }
        options={[
          { value: 'none', label: 'Include even if previously produced' },
          { value: 'any_earlier', label: 'Exclude anything produced in any earlier production' },
        ]}
      />
    </section>
  );
}

function OutputStep({
  p,
  patch,
}: {
  p: ProductionParameters;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  const mode = p.output.mode;
  return (
    <section aria-label="Step 3: output mode">
      <RadioGroup
        legend="Output mode"
        name="output-mode"
        value={mode}
        onChange={(v) => {
          if (v === 'natives_only') patch({ output: { mode: 'natives_only' } });
          else if (v === 'pdf_only')
            patch({ output: { mode: 'pdf_only', pdfGrouping: 'per_document' } });
          else
            patch({
              output: {
                mode: 'load_file',
                imageFormat: 'tiff_g4',
                includeNatives: false,
                includeText: true,
                loadFileFormats: ['dat'],
              },
            });
        }}
        options={[
          { value: 'natives_only', label: 'Natives only' },
          { value: 'pdf_only', label: 'PDFs' },
          { value: 'load_file', label: 'Load file (images + DAT/OPT/CSV)' },
        ]}
      />
      {p.output.mode === 'pdf_only' ? (
        <Select
          label="PDF grouping"
          value={p.output.pdfGrouping}
          onChange={(e) =>
            patch({
              output: {
                mode: 'pdf_only',
                pdfGrouping: e.target.value as Extract<
                  ProductionParameters['output'],
                  { mode: 'pdf_only' }
                >['pdfGrouping'],
              },
            })
          }
          options={[
            { value: 'per_page', label: 'One PDF per page' },
            { value: 'per_document', label: 'One PDF per document' },
            { value: 'per_family', label: 'One PDF per family' },
            { value: 'bulk', label: 'Single bulk PDF' },
          ]}
        />
      ) : null}
      {p.output.mode === 'load_file' ? <LoadFileOptions output={p.output} patch={patch} /> : null}
    </section>
  );
}

type LoadFileOutput = Extract<ProductionParameters['output'], { mode: 'load_file' }>;

function LoadFileOptions({
  output,
  patch,
}: {
  output: LoadFileOutput;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  return (
    <>
      <Select
        label="Image format"
        value={output.imageFormat}
        onChange={(e) =>
          patch({
            output: { ...output, imageFormat: e.target.value as LoadFileOutput['imageFormat'] },
          })
        }
        options={[
          { value: 'tiff_g4', label: 'TIFF (Group 4)' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'pdf', label: 'PDF' },
          { value: 'none', label: 'No images' },
        ]}
      />
      <Checkbox
        label="Include natives"
        checked={output.includeNatives}
        onChange={(e) => patch({ output: { ...output, includeNatives: e.target.checked } })}
      />
      <Checkbox
        label="Include extracted text"
        checked={output.includeText}
        onChange={(e) => patch({ output: { ...output, includeText: e.target.checked } })}
      />
      <fieldset className="cdfir-fieldset">
        <legend>Load-file formats</legend>
        {(['dat', 'opt', 'csv'] as const).map((fmt) => (
          <Checkbox
            key={fmt}
            label={fmt.toUpperCase()}
            checked={output.loadFileFormats.includes(fmt)}
            onChange={(e) =>
              patch({
                output: {
                  ...output,
                  loadFileFormats: e.target.checked
                    ? [...output.loadFileFormats, fmt]
                    : output.loadFileFormats.filter((f) => f !== fmt),
                },
              })
            }
          />
        ))}
      </fieldset>
    </>
  );
}

function NativesStep({
  p,
  patch,
}: {
  p: ProductionParameters;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  const tags = useTags();
  const [extText, setExtText] = useState(p.nativePolicy.extensions.join(', '));
  return (
    <section aria-label="Step 4: native policy">
      <Notice variant="info">
        Redacted and privileged items are always excluded from native output regardless of this
        list, unless a security-critical override with a second confirmation is recorded at
        validation.
      </Notice>
      <TextInput
        label="Always produce natively — file extensions"
        hint="Comma-separated, lowercase, no dots (e.g. xlsx, csv, mdb)."
        value={extText}
        onChange={(e) => {
          setExtText(e.target.value);
          patch({
            nativePolicy: {
              ...p.nativePolicy,
              extensions: e.target.value
                .split(',')
                .map((s) => s.trim().toLowerCase())
                .filter((s) => /^[a-z0-9]{1,10}$/.test(s)),
            },
          });
        }}
      />
      <fieldset className="cdfir-fieldset">
        <legend>Always produce natively — tags</legend>
        {(tags.data?.items ?? []).map((t) => (
          <Checkbox
            key={t.id}
            label={t.name}
            checked={p.nativePolicy.tagIds.includes(t.id)}
            onChange={(e) =>
              patch({
                nativePolicy: {
                  ...p.nativePolicy,
                  tagIds: e.target.checked
                    ? [...p.nativePolicy.tagIds, t.id]
                    : p.nativePolicy.tagIds.filter((x) => x !== t.id),
                },
              })
            }
          />
        ))}
      </fieldset>
    </section>
  );
}

function StampsStep({
  p,
  patch,
}: {
  p: ProductionParameters;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  const positions = stampPosition.options;
  return (
    <section aria-label="Step 6: stamps">
      <p>Configure up to six stamp slots — one per page position.</p>
      <div className="stamp-grid">
        {positions.map((pos) => {
          const existing = p.stamps.find((s) => s.position === pos);
          return (
            <fieldset key={pos} className="cdfir-fieldset">
              <legend>{pos.replaceAll('_', ' ')}</legend>
              <Select
                label="Stamp kind"
                value={existing?.kind ?? ''}
                placeholder="(unused)"
                onChange={(e) => {
                  const kind = e.target.value;
                  const others = p.stamps.filter((s) => s.position !== pos);
                  if (!kind) {
                    patch({ stamps: others });
                  } else {
                    patch({
                      stamps: [
                        ...others,
                        {
                          position: pos,
                          kind: kind as 'bates' | 'tag' | 'confidentiality' | 'custom',
                          text: existing?.text ?? '',
                          priority: existing?.priority ?? 5,
                          addedMarginPoints: existing?.addedMarginPoints ?? 0,
                        },
                      ],
                    });
                  }
                }}
                options={[
                  { value: 'bates', label: 'Bates number' },
                  { value: 'tag', label: 'Tag text' },
                  { value: 'confidentiality', label: 'Confidentiality legend' },
                  { value: 'custom', label: 'Custom text' },
                ]}
              />
              {existing ? (
                <>
                  {existing.kind === 'custom' || existing.kind === 'confidentiality' ? (
                    <TextInput
                      label="Stamp text"
                      value={existing.text}
                      onChange={(e) =>
                        patch({
                          stamps: p.stamps.map((s) =>
                            s.position === pos ? { ...s, text: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <TextInput
                    label="Priority (1–10)"
                    type="number"
                    min={1}
                    max={10}
                    value={existing.priority}
                    onChange={(e) =>
                      patch({
                        stamps: p.stamps.map((s) =>
                          s.position === pos ? { ...s, priority: Number(e.target.value) } : s,
                        ),
                      })
                    }
                  />
                  <TextInput
                    label="Added margin (points, 0–72)"
                    type="number"
                    min={0}
                    max={72}
                    value={existing.addedMarginPoints}
                    onChange={(e) =>
                      patch({
                        stamps: p.stamps.map((s) =>
                          s.position === pos
                            ? { ...s, addedMarginPoints: Number(e.target.value) }
                            : s,
                        ),
                      })
                    }
                  />
                </>
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}

function RedactionsStep({
  p,
  patch,
}: {
  p: ProductionParameters;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  const r = p.redactions;
  return (
    <section aria-label="Step 7: redactions">
      <RadioGroup
        legend="Redaction stage to apply"
        name="redaction-stage"
        value={r.stage}
        onChange={(v) => patch({ redactions: { ...r, stage: v as 'preview' | 'final' } })}
        options={[
          {
            value: 'final',
            label: 'Final redactions',
            description: 'Only finalized redactions are burned in.',
          },
          {
            value: 'preview',
            label: 'Preview redactions',
            description:
              'Includes not-yet-final redactions — flagged at validation for release sets.',
          },
        ]}
      />
      <TextInput
        label="Redaction color"
        type="color"
        value={r.color}
        onChange={(e) => patch({ redactions: { ...r, color: e.target.value } })}
      />
      <TextInput
        label="Redaction label"
        value={r.label}
        onChange={(e) => patch({ redactions: { ...r, label: e.target.value } })}
      />
      <Checkbox
        label="Force image-only output for redacted documents (recommended)"
        checked={r.enforceImageOnly}
        onChange={(e) => patch({ redactions: { ...r, enforceImageOnly: e.target.checked } })}
      />
    </section>
  );
}

function BatesStep({
  p,
  patch,
}: {
  p: ProductionParameters;
  patch: (x: Partial<ProductionParameters>) => void;
}) {
  const b = p.bates;
  return (
    <section aria-label="Step 8: bates numbering">
      <TextInput
        label="Prefix"
        value={b.prefix}
        onChange={(e) => patch({ bates: { ...b, prefix: e.target.value } })}
      />
      <TextInput
        label="Start number"
        type="number"
        min={1}
        value={b.startNumber}
        onChange={(e) => patch({ bates: { ...b, startNumber: Number(e.target.value) } })}
      />
      <TextInput
        label="Digits (4–12)"
        type="number"
        min={4}
        max={12}
        value={b.digits}
        onChange={(e) => patch({ bates: { ...b, digits: Number(e.target.value) } })}
      />
      <TextInput
        label="Suffix"
        value={b.suffix}
        onChange={(e) => patch({ bates: { ...b, suffix: e.target.value } })}
      />
      <RadioGroup
        legend="Numbering"
        name="bates-numbering"
        value={b.numbering}
        onChange={(v) => patch({ bates: { ...b, numbering: v as 'per_page' | 'per_document' } })}
        options={[
          { value: 'per_page', label: 'Per page' },
          { value: 'per_document', label: 'Per document' },
        ]}
      />
      <p aria-live="polite">
        Example first number: <strong className="mono">{formatBates(b)}</strong>
      </p>
    </section>
  );
}

function ValidateStep({
  state,
  dispatch,
  onDone,
}: {
  state: ProductionWizardState;
  dispatch: (a: ProductionWizardAction) => void;
  onDone: (productionId: string) => void;
}) {
  const me = useMe();
  const create = useCreateProduction();
  const validate = useValidateProduction();
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [acks, setAcks] = useState<ReadonlySet<string>>(new Set());
  const [secondConfirmation, setSecondConfirmation] = useState('');
  const [statusText, setStatusText] = useState('');
  const submit = useSubmitProduction(state.draftId ?? '');

  const canElevate = (me.data?.roles ?? []).some(
    (r) => r === 'org_admin' || r === 'production_manager',
  );

  function runValidation() {
    setStatusText('Validating production…');
    const proceed = (draftId: string) =>
      validate.mutate(draftId, {
        onSuccess: (result) => {
          setValidation(result);
          setAcks(new Set());
          setStatusText(`Validation complete: ${result.flags.length} flag(s).`);
        },
        onError: (err) => setStatusText(errorMessage(err)),
      });
    if (state.draftId) {
      proceed(state.draftId);
    } else {
      create.mutate(
        {
          idempotencyKey: state.idempotencyKey,
          ...(state.caseId ? { caseId: state.caseId } : {}),
          parameters: state.parameters,
        },
        {
          onSuccess: (data) => {
            dispatch({ type: 'setDraftId', draftId: data.id });
            proceed(data.id);
          },
          onError: (err) => setStatusText(errorMessage(err)),
        },
      );
    }
  }

  const flags = validation?.flags ?? [];
  const bySeverity = {
    security_critical: flags.filter((f) => f.severity === 'security_critical'),
    blocking: flags.filter((f) => f.severity === 'blocking'),
    warning: flags.filter((f) => f.severity === 'warning'),
    info: flags.filter((f) => f.severity === 'info'),
  };
  const needsAck = flags.filter(
    (f) => (f.severity === 'warning' || f.severity === 'security_critical') && f.overridable,
  );
  const hasSecurityCritical = bySeverity.security_critical.length > 0;
  const securityBlocked = hasSecurityCritical && !canElevate;
  const allAcked = needsAck.every((f) => acks.has(f.code));
  const phraseOk = !hasSecurityCritical || secondConfirmation === SECURITY_PHRASE;
  const canSubmit =
    validation !== null &&
    validation.canSubmit &&
    bySeverity.blocking.length === 0 &&
    !securityBlocked &&
    allAcked &&
    phraseOk;

  return (
    <section aria-label="Step 10: validate and submit">
      <TruthNotice kind="defensibility" variant="warning" />
      <ParameterSummary state={state} />
      <div className="button-row">
        <Button onClick={runValidation} busy={create.isPending || validate.isPending}>
          {validation ? 'Re-validate' : 'Validate production'}
        </Button>
      </div>
      <StatusLive politeness="polite">{statusText}</StatusLive>

      {validation ? (
        <>
          <p>
            {validation.itemCount} item(s)
            {validation.estimatedPageCount !== null
              ? `, an estimated ${validation.estimatedPageCount} page(s)`
              : ''}
            . Draft calculated {validation.draftCalculatedAt}.
          </p>
          {(['security_critical', 'blocking', 'warning', 'info'] as const).map((severity) => {
            const group = bySeverity[severity];
            if (group.length === 0) return null;
            return (
              <section key={severity} aria-label={`${severity} flags`}>
                <h3>
                  {severity.replaceAll('_', ' ')} ({group.length})
                </h3>
                <ul>
                  {group.map((f) => (
                    <li key={f.code}>
                      <strong>{f.code.replaceAll('_', ' ')}</strong>: {f.message} (
                      {f.evidenceItemIds.length} item(s))
                      {(severity === 'warning' || severity === 'security_critical') &&
                      f.overridable ? (
                        <Checkbox
                          label={`Acknowledge and override "${f.code.replaceAll('_', ' ')}"`}
                          checked={acks.has(f.code)}
                          disabled={severity === 'security_critical' && !canElevate}
                          onChange={(e) => {
                            const next = new Set(acks);
                            if (e.target.checked) next.add(f.code);
                            else next.delete(f.code);
                            setAcks(next);
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {bySeverity.blocking.length > 0 ? (
            <Notice variant="warning">
              Blocking flags cannot be overridden. Adjust the selection or configuration, then
              re-validate.
            </Notice>
          ) : null}
          {securityBlocked ? (
            <Notice variant="warning">
              Security-critical flags require an org admin or production manager to override. Your
              role does not permit submitting this production.
            </Notice>
          ) : null}
          {hasSecurityCritical && canElevate ? (
            <TextInput
              label={`Second confirmation — type "${SECURITY_PHRASE}" to enable submission`}
              value={secondConfirmation}
              onChange={(e) => setSecondConfirmation(e.target.value)}
            />
          ) : null}

          <div className="wizard-actions">
            <Button
              disabled={!canSubmit}
              busy={submit.isPending}
              onClick={() => {
                if (!validation || !state.draftId) return;
                submit.mutate(
                  {
                    acknowledgedWarnings: needsAck
                      .filter((f) => acks.has(f.code))
                      .map((f) => ({
                        code: f.code,
                        note: '',
                        secondConfirmation:
                          f.severity === 'security_critical' &&
                          secondConfirmation === SECURITY_PHRASE,
                      })),
                    expectedDraftCalculatedAt: validation.draftCalculatedAt,
                  },
                  {
                    onSuccess: () => onDone(state.draftId as string),
                    onError: (err) => setStatusText(errorMessage(err)),
                  },
                );
              }}
            >
              Submit production run
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ParameterSummary({ state }: { state: ProductionWizardState }) {
  const p = state.parameters;
  return (
    <details>
      <summary>Parameter summary</summary>
      <ul>
        <li>Name: {p.name}</li>
        <li>
          Selection: {p.selection.tagIds.length} tag(s), {p.selection.savedSearchIds.length} saved
          search(es){p.selection.inverted ? ', inverted' : ''}
          {p.selection.excludePreviouslyProduced.kind !== 'none'
            ? ', excluding previously produced'
            : ''}
        </li>
        <li>Output: {p.output.mode.replaceAll('_', ' ')}</li>
        <li>Sort: {p.sort.replaceAll('_', ' ')}</li>
        <li>Stamps: {p.stamps.length}</li>
        <li>
          Redactions: {p.redactions.stage}, image-only{' '}
          {p.redactions.enforceImageOnly ? 'on' : 'off'}
        </li>
        <li>
          Bates: <span className="mono">{formatBates(p.bates)}</span> (
          {p.bates.numbering.replaceAll('_', ' ')})
        </li>
        <li>Filenames: {p.filenames.replaceAll('_', ' ')}</li>
      </ul>
    </details>
  );
}
