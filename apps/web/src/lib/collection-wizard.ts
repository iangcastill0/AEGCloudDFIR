/**
 * State machine for the 8-step collection wizard (contract §6).
 * Pure (no DOM) so step gating, persistence and idempotency-key stability
 * are unit testable. The page component owns sessionStorage persistence via
 * serializeWizard / hydrateWizard.
 */
import { z } from 'zod';
import { createCollectionRequest, type CreateCollectionRequest } from '@evidencevault/contracts';

export const WIZARD_STEPS = [
  'Provider',
  'Account',
  'Sources',
  'Custodians',
  'Scope',
  'Type',
  'Review',
  'Start',
] as const;

export const STEP_PROVIDER = 0;
export const STEP_ACCOUNT = 1;
export const STEP_SOURCES = 2;
export const STEP_CUSTODIANS = 3;
export const STEP_SCOPE = 4;
export const STEP_TYPE = 5;
export const STEP_REVIEW = 6;
export const STEP_START = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const wizardCustodian = z.object({ id: z.string(), email: z.string() });

/** Persisted shape — versioned so stale sessionStorage never breaks resume. */
export const wizardStateSchema = z.object({
  v: z.literal(1),
  step: z.number().int().min(0).max(7),
  maxStepReached: z.number().int().min(0).max(7),
  /** Generated once per wizard run; reused across retries of the same start. */
  idempotencyKey: z.string().min(8),
  name: z.string(),
  provider: z.enum(['microsoft', 'google', '']),
  connectorAccountId: z.string(),
  connectorMode: z.enum(['delegated', 'organization', '']),
  sources: z.object({ email: z.boolean(), drive: z.boolean() }),
  custodians: z.array(wizardCustodian),
  scope: z.object({
    dateKind: z.enum(['all_time', 'range']),
    startDate: z.string(),
    endDate: z.string(),
    timezone: z.string(),
    emailAllFolders: z.boolean(),
    emailFolderIdsText: z.string(),
    includeSpam: z.boolean(),
    includeTrash: z.boolean(),
    includeRecoverableItems: z.boolean(),
    driveAllRoots: z.boolean(),
    driveRootIdsText: z.string(),
    includeSharedDrives: z.boolean(),
    includeTrashed: z.boolean(),
  }),
  kind: z.enum(['snapshot', 'continuous']),
});
export type WizardState = z.infer<typeof wizardStateSchema>;

export function freshWizard(idempotencyKey: string): WizardState {
  return {
    v: 1,
    step: 0,
    maxStepReached: 0,
    idempotencyKey,
    name: '',
    provider: '',
    connectorAccountId: '',
    connectorMode: '',
    sources: { email: true, drive: false },
    custodians: [],
    scope: {
      dateKind: 'all_time',
      startDate: '',
      endDate: '',
      timezone: '',
      emailAllFolders: true,
      emailFolderIdsText: '',
      includeSpam: false,
      includeTrash: false,
      includeRecoverableItems: false,
      driveAllRoots: true,
      driveRootIdsText: '',
      includeSharedDrives: false,
      includeTrashed: false,
    },
    kind: 'snapshot',
  };
}

/** Validation errors for a single step (empty array = step is valid). */
export function validateStep(state: WizardState, step: number): string[] {
  const errors: string[] = [];
  switch (step) {
    case STEP_PROVIDER:
      if (!state.provider) errors.push('Choose a provider.');
      if (state.name.trim().length === 0) errors.push('Give the collection a name.');
      if (state.name.trim().length > 200) errors.push('Name must be 200 characters or fewer.');
      break;
    case STEP_ACCOUNT:
      if (!state.connectorAccountId) errors.push('Select a connected account.');
      break;
    case STEP_SOURCES:
      if (!state.sources.email && !state.sources.drive)
        errors.push('Select at least one source (email, drive, or both).');
      break;
    case STEP_CUSTODIANS:
      if (state.custodians.length === 0) errors.push('Add at least one custodian.');
      break;
    case STEP_SCOPE: {
      const s = state.scope;
      if (s.dateKind === 'range') {
        if (!DATE_RE.test(s.startDate)) errors.push('Start date must be YYYY-MM-DD.');
        if (!DATE_RE.test(s.endDate)) errors.push('End date must be YYYY-MM-DD.');
        if (DATE_RE.test(s.startDate) && DATE_RE.test(s.endDate) && s.startDate > s.endDate)
          errors.push('Start date must be on or before the end date.');
        if (s.timezone.trim().length === 0)
          errors.push('Select the IANA timezone the date range should be interpreted in.');
      }
      if (
        state.sources.email &&
        !s.emailAllFolders &&
        parseIdList(s.emailFolderIdsText).length === 0
      )
        errors.push('List at least one email folder, or choose all folders.');
      if (state.sources.drive && !s.driveAllRoots && parseIdList(s.driveRootIdsText).length === 0)
        errors.push('List at least one drive root, or choose the default drive.');
      break;
    }
    case STEP_TYPE:
      // kind is constrained by the type; nothing free-form to validate.
      break;
    case STEP_REVIEW: {
      for (let s = 0; s < STEP_REVIEW; s += 1) errors.push(...validateStep(state, s));
      break;
    }
    default:
      break;
  }
  return errors;
}

export function canAdvance(state: WizardState): boolean {
  return validateStep(state, state.step).length === 0;
}

export type WizardAction =
  | {
      type: 'patch';
      patch: Partial<
        Omit<WizardState, 'v' | 'scope' | 'step' | 'maxStepReached' | 'idempotencyKey'>
      >;
    }
  | { type: 'patchScope'; patch: Partial<WizardState['scope']> }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: number };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'patchScope':
      return { ...state, scope: { ...state.scope, ...action.patch } };
    case 'next': {
      if (state.step >= STEP_START) return state;
      if (!canAdvance(state)) return state; // gate: invalid step never advances
      const step = state.step + 1;
      return { ...state, step, maxStepReached: Math.max(state.maxStepReached, step) };
    }
    case 'back':
      return state.step === 0 ? state : { ...state, step: state.step - 1 };
    case 'goto': {
      // Back-navigation (and revisiting already-reached steps) is always allowed.
      if (action.step < 0 || action.step > state.maxStepReached) return state;
      return { ...state, step: action.step };
    }
  }
}

export function serializeWizard(state: WizardState): string {
  return JSON.stringify(state);
}

/** Resume from sessionStorage; falls back to a fresh wizard on any mismatch. */
export function hydrateWizard(raw: string | null, freshKey: string): WizardState {
  if (!raw) return freshWizard(freshKey);
  try {
    const parsed = wizardStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : freshWizard(freshKey);
  } catch {
    return freshWizard(freshKey);
  }
}

export function parseIdList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the POST /api/v1/collections body; throws if the wizard is invalid. */
export function buildCreateRequest(state: WizardState): CreateCollectionRequest {
  const sources: Array<'email' | 'drive'> = [];
  if (state.sources.email) sources.push('email');
  if (state.sources.drive) sources.push('drive');

  const body = {
    idempotencyKey: state.idempotencyKey,
    connectorAccountId: state.connectorAccountId,
    name: state.name.trim(),
    kind: state.kind,
    sources,
    custodianIds: state.custodians.map((c) => c.id),
    scope: {
      dateRange:
        state.scope.dateKind === 'all_time'
          ? { kind: 'all_time' as const }
          : {
              kind: 'range' as const,
              startDate: state.scope.startDate,
              endDate: state.scope.endDate,
              timezone: state.scope.timezone,
            },
      ...(state.sources.email
        ? {
            email: {
              folderIds: state.scope.emailAllFolders
                ? null
                : parseIdList(state.scope.emailFolderIdsText),
              includeSpam: state.scope.includeSpam,
              includeTrash: state.scope.includeTrash,
              includeRecoverableItems: state.scope.includeRecoverableItems,
            },
          }
        : {}),
      ...(state.sources.drive
        ? {
            drive: {
              driveIds: state.scope.driveAllRoots
                ? null
                : parseIdList(state.scope.driveRootIdsText),
              folderIds: null,
              includeSharedDrives: state.scope.includeSharedDrives,
              includeTrashed: state.scope.includeTrashed,
            },
          }
        : {}),
    },
  };
  return createCollectionRequest.parse(body);
}
