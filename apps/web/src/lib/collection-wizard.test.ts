import { describe, expect, it } from 'vitest';
import {
  STEP_CUSTODIANS,
  STEP_REVIEW,
  STEP_SCOPE,
  buildCreateRequest,
  canAdvance,
  freshWizard,
  hydrateWizard,
  serializeWizard,
  validateStep,
  wizardReducer,
  type WizardState,
} from './collection-wizard';

const KEY = 'test-idempotency-key-1234';

function filledWizard(): WizardState {
  let s = freshWizard(KEY);
  s = wizardReducer(s, {
    type: 'patch',
    patch: {
      name: 'Acme v. Foo — mailbox sweep',
      provider: 'google',
      connectorAccountId: '4f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b',
      connectorMode: 'organization',
      custodians: [{ id: '2f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b', email: 'alice@acme.example' }],
    },
  });
  return s;
}

describe('wizard step gating', () => {
  it('does not advance past step 1 (provider) without provider and name', () => {
    const s = freshWizard(KEY);
    const after = wizardReducer(s, { type: 'next' });
    expect(after.step).toBe(0);
    expect(validateStep(s, 0).length).toBeGreaterThan(0);
  });

  it('cannot advance past the scope step when a range is missing its timezone', () => {
    let s = filledWizard();
    // walk to the scope step
    for (let i = 0; i < STEP_SCOPE; i += 1) s = wizardReducer(s, { type: 'next' });
    expect(s.step).toBe(STEP_SCOPE);
    s = wizardReducer(s, {
      type: 'patchScope',
      patch: { dateKind: 'range', startDate: '2023-01-01', endDate: '2023-06-30', timezone: '' },
    });
    expect(canAdvance(s)).toBe(false);
    const stuck = wizardReducer(s, { type: 'next' });
    expect(stuck.step).toBe(STEP_SCOPE);
    expect(validateStep(s, STEP_SCOPE).join(' ')).toMatch(/timezone/i);

    const fixed = wizardReducer(s, { type: 'patchScope', patch: { timezone: 'America/Chicago' } });
    expect(wizardReducer(fixed, { type: 'next' }).step).toBe(STEP_SCOPE + 1);
  });

  it('rejects an inverted date range', () => {
    let s = filledWizard();
    s = wizardReducer(s, {
      type: 'patchScope',
      patch: { dateKind: 'range', startDate: '2024-02-02', endDate: '2024-01-01', timezone: 'UTC' },
    });
    expect(validateStep(s, STEP_SCOPE).join(' ')).toMatch(/on or before/);
  });

  it('requires at least one custodian', () => {
    const s = { ...filledWizard(), custodians: [] };
    expect(validateStep(s, STEP_CUSTODIANS).length).toBe(1);
  });

  it('review step aggregates earlier-step errors', () => {
    const s = { ...freshWizard(KEY), step: STEP_REVIEW };
    expect(validateStep(s, STEP_REVIEW).length).toBeGreaterThan(1);
  });

  it('goto never jumps beyond the furthest step reached; back always works', () => {
    let s = filledWizard();
    s = wizardReducer(s, { type: 'next' });
    expect(wizardReducer(s, { type: 'goto', step: 5 })).toBe(s);
    expect(wizardReducer(s, { type: 'goto', step: 0 }).step).toBe(0);
    expect(wizardReducer(s, { type: 'back' }).step).toBe(0);
  });
});

describe('resume from sessionStorage', () => {
  it('round-trips serialize → hydrate preserving step, data, and idempotency key', () => {
    let s = filledWizard();
    s = wizardReducer(s, { type: 'next' });
    s = wizardReducer(s, { type: 'next' });
    const resumed = hydrateWizard(serializeWizard(s), 'other-key-abcdefgh');
    expect(resumed).toEqual(s);
    expect(resumed.idempotencyKey).toBe(KEY); // NOT replaced by the fresh key
  });

  it('falls back to a fresh wizard on corrupt or wrong-shape storage', () => {
    expect(hydrateWizard('not json{{', KEY).step).toBe(0);
    expect(hydrateWizard(JSON.stringify({ v: 99 }), KEY).idempotencyKey).toBe(KEY);
    expect(hydrateWizard(null, KEY).name).toBe('');
  });
});

describe('idempotency key stability', () => {
  it('the key survives reducer transitions, so a retried start reuses it', () => {
    let s = filledWizard();
    for (const action of [
      { type: 'next' } as const,
      { type: 'back' } as const,
      { type: 'patchScope', patch: { includeSpam: true } } as const,
    ]) {
      s = wizardReducer(s, action);
    }
    expect(s.idempotencyKey).toBe(KEY);
    const req1 = buildCreateRequest(filledWizard());
    const req2 = buildCreateRequest(filledWizard());
    expect(req1.idempotencyKey).toBe(req2.idempotencyKey);
  });
});

describe('buildCreateRequest', () => {
  it('produces a contract-valid body with null folder lists meaning "all"', () => {
    const req = buildCreateRequest(filledWizard());
    expect(req.sources).toEqual(['email']);
    expect(req.scope.email?.folderIds).toBeNull();
    expect(req.scope.drive).toBeUndefined();
    expect(req.scope.dateRange.kind).toBe('all_time');
  });

  it('emits explicit folder ids and the range timezone when set', () => {
    let s = filledWizard();
    s = wizardReducer(s, { type: 'patch', patch: { sources: { email: true, drive: true } } });
    s = wizardReducer(s, {
      type: 'patchScope',
      patch: {
        dateKind: 'range',
        startDate: '2023-01-01',
        endDate: '2023-06-30',
        timezone: 'America/Chicago',
        emailAllFolders: false,
        emailFolderIdsText: 'inbox, sent\narchive',
      },
    });
    const req = buildCreateRequest(s);
    expect(req.scope.email?.folderIds).toEqual(['inbox', 'sent', 'archive']);
    expect(req.scope.drive?.driveIds).toBeNull();
    expect(req.scope.dateRange).toEqual({
      kind: 'range',
      startDate: '2023-01-01',
      endDate: '2023-06-30',
      timezone: 'America/Chicago',
    });
  });

  it('throws when the wizard state is not contract-valid', () => {
    const s = { ...filledWizard(), custodians: [] };
    expect(() => buildCreateRequest(s)).toThrow();
  });
});
