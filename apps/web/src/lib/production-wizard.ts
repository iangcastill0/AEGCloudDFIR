/**
 * State + validation for the 10-step production wizard (contract §12).
 * Pure so step gating and the live Bates preview are unit testable.
 */
import { z } from 'zod';
import type { ProductionParameters } from '@evidencevault/contracts';

export const PRODUCTION_STEPS = [
  'Name',
  'Selection',
  'Output',
  'Natives',
  'Sort',
  'Stamps',
  'Redactions',
  'Bates',
  'Filenames',
  'Validate & submit',
] as const;

export interface ProductionWizardState {
  step: number;
  maxStepReached: number;
  idempotencyKey: string;
  caseId: string;
  /** Draft production id once created server-side (before validate). */
  draftId: string | null;
  parameters: ProductionParameters;
}

export function freshProductionWizard(idempotencyKey: string): ProductionWizardState {
  return {
    step: 0,
    maxStepReached: 0,
    idempotencyKey,
    caseId: '',
    draftId: null,
    parameters: {
      name: '',
      description: '',
      selection: {
        tagIds: [],
        savedSearchIds: [],
        inverted: false,
        excludePreviouslyProduced: { kind: 'none' },
        includeFamilies: true,
      },
      output: { mode: 'natives_only' },
      nativePolicy: { extensions: [], tagIds: [], subjectToSafetyOverrides: true },
      sort: 'folder_filename',
      stamps: [],
      redactions: { stage: 'final', color: '#000000', label: 'REDACTED', enforceImageOnly: true },
      bates: { prefix: 'PROD', startNumber: 1, digits: 8, suffix: '', numbering: 'per_page' },
      filenames: 'bates',
    },
  };
}

export function validateProductionStep(state: ProductionWizardState, step: number): string[] {
  const errors: string[] = [];
  const p = state.parameters;
  switch (step) {
    case 0:
      if (p.name.trim().length === 0) errors.push('Name the production.');
      break;
    case 1:
      if (p.selection.tagIds.length === 0 && p.selection.savedSearchIds.length === 0)
        errors.push('Select at least one tag or saved search.');
      break;
    case 2:
      if (p.output.mode === 'load_file' && p.output.loadFileFormats.length === 0)
        errors.push('Choose at least one load-file format.');
      break;
    case 5: {
      if (p.stamps.length > 6) errors.push('At most six stamp slots.');
      const positions = p.stamps.map((s) => s.position);
      if (new Set(positions).size !== positions.length)
        errors.push('Each stamp position can be used only once.');
      for (const s of p.stamps) {
        if (s.kind === 'custom' && s.text.trim().length === 0)
          errors.push(`Custom stamp at ${s.position} needs text.`);
      }
      break;
    }
    case 7: {
      const bates = z.object({
        prefix: z.string().regex(/^[A-Za-z0-9_-]{0,20}$/),
        startNumber: z.number().int().min(1),
        digits: z.number().int().min(4).max(12),
        suffix: z.string().regex(/^[A-Za-z0-9_-]{0,10}$/),
      });
      const res = bates.safeParse(p.bates);
      if (!res.success)
        errors.push(...res.error.issues.map((i) => `Bates ${i.path.join('.')}: ${i.message}`));
      break;
    }
    case 9: {
      for (let s = 0; s < 9; s += 1) errors.push(...validateProductionStep(state, s));
      break;
    }
    default:
      break;
  }
  return errors;
}

export function canAdvanceProduction(state: ProductionWizardState): boolean {
  return validateProductionStep(state, state.step).length === 0;
}

export type ProductionWizardAction =
  | { type: 'patchParams'; patch: Partial<ProductionParameters> }
  | { type: 'setCaseId'; caseId: string }
  | { type: 'setDraftId'; draftId: string }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: number };

export function productionWizardReducer(
  state: ProductionWizardState,
  action: ProductionWizardAction,
): ProductionWizardState {
  switch (action.type) {
    case 'patchParams':
      return { ...state, parameters: { ...state.parameters, ...action.patch } };
    case 'setCaseId':
      return { ...state, caseId: action.caseId };
    case 'setDraftId':
      return { ...state, draftId: action.draftId };
    case 'next': {
      if (state.step >= PRODUCTION_STEPS.length - 1) return state;
      if (!canAdvanceProduction(state)) return state;
      const step = state.step + 1;
      return { ...state, step, maxStepReached: Math.max(state.maxStepReached, step) };
    }
    case 'back':
      return state.step === 0 ? state : { ...state, step: state.step - 1 };
    case 'goto':
      if (action.step < 0 || action.step > state.maxStepReached) return state;
      return { ...state, step: action.step };
  }
}

/** Live preview of an example Bates number, e.g. PROD00000042-A. */
export function formatBates(
  config: { prefix: string; startNumber: number; digits: number; suffix: string },
  offset = 0,
): string {
  const n = config.startNumber + offset;
  const padded = String(n).padStart(config.digits, '0');
  return `${config.prefix}${padded}${config.suffix}`;
}
