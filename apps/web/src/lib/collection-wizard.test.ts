import { describe, expect, it } from 'vitest';
import {
  STEP_ACCOUNT,
  STEP_CUSTODIANS,
  STEP_REVIEW,
  STEP_SCOPE,
  STEP_SOURCES,
  STEP_TYPE,
  buildCreateRequest,
  canAdvance,
  freshWizard,
  hydrateWizard,
  serializeWizard,
  sourcesForProvider,
  validateStep,
  wizardReducer,
  wizardStepLabels,
  type WizardState,
  type WizardUpload,
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

const PST_UPLOAD: WizardUpload = {
  uploadId: 'up-11111111',
  filename: 'alice-archive.pst',
  sha256: 'f'.repeat(64),
  size: 52_428_800,
};

function uploadWizard(): WizardState {
  let s = freshWizard(KEY);
  s = wizardReducer(s, {
    type: 'patch',
    patch: {
      name: 'PST intake — Doe custodial files',
      provider: 'upload',
      sources: { email: true, drive: false, audit: false },
      kind: 'snapshot',
    },
  });
  return s;
}

describe('upload provider path', () => {
  it('relabels the Account step as Upload', () => {
    expect(wizardStepLabels(uploadWizard())[STEP_ACCOUNT]).toBe('Upload');
    expect(wizardStepLabels(freshWizard(KEY))[STEP_ACCOUNT]).toBe('Account');
  });

  it('cannot pass the Upload step with zero completed uploads', () => {
    let s = uploadWizard();
    s = wizardReducer(s, { type: 'next' });
    expect(s.step).toBe(STEP_ACCOUNT);
    expect(validateStep(s, STEP_ACCOUNT).join(' ')).toMatch(/\.pst/);
    expect(wizardReducer(s, { type: 'next' }).step).toBe(STEP_ACCOUNT); // gated

    s = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    expect(validateStep(s, STEP_ACCOUNT)).toEqual([]);
    expect(wizardReducer(s, { type: 'next' }).step).toBe(STEP_ACCOUNT + 1);
  });

  it('addUpload is idempotent by uploadId; removeUpload takes it back out', () => {
    let s = uploadWizard();
    s = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    s = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    expect(s.uploads).toHaveLength(1);
    s = wizardReducer(s, { type: 'removeUpload', uploadId: PST_UPLOAD.uploadId });
    expect(s.uploads).toHaveLength(0);
  });

  it('sources and scope steps are informational (never block) for uploads', () => {
    const s = uploadWizard();
    expect(validateStep(s, STEP_SOURCES)).toEqual([]);
    expect(validateStep(s, STEP_SCOPE)).toEqual([]);
  });

  it('requires a valid custodian email on the custodian step', () => {
    let s = uploadWizard();
    expect(validateStep(s, STEP_CUSTODIANS).join(' ')).toMatch(/valid custodian email/i);
    s = wizardReducer(s, {
      type: 'patch',
      patch: { uploadCustodian: { email: 'not-an-email', displayName: '' } },
    });
    expect(validateStep(s, STEP_CUSTODIANS).length).toBe(1);
    s = wizardReducer(s, {
      type: 'patch',
      patch: { uploadCustodian: { email: 'alice@acme.example', displayName: 'Alice Doe' } },
    });
    expect(validateStep(s, STEP_CUSTODIANS)).toEqual([]);
  });

  it('rejects continuous collections for uploads', () => {
    let s = uploadWizard();
    s = wizardReducer(s, { type: 'patch', patch: { kind: 'continuous' } });
    expect(validateStep(s, STEP_TYPE).join(' ')).toMatch(/snapshot/i);
  });

  it('buildCreateRequest emits uploadCustodian + scope.uploads and omits the connector', () => {
    let s = uploadWizard();
    s = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    s = wizardReducer(s, {
      type: 'addUpload',
      upload: { ...PST_UPLOAD, uploadId: 'up-22222222', filename: 'bob.ost' },
    });
    s = wizardReducer(s, {
      type: 'patch',
      patch: { uploadCustodian: { email: 'alice@acme.example', displayName: ' Alice Doe ' } },
    });
    const req = buildCreateRequest(s);
    expect(req.connectorAccountId).toBeUndefined();
    expect(req.kind).toBe('snapshot');
    expect(req.sources).toEqual(['email']);
    expect(req.custodianIds).toEqual([]);
    expect(req.uploadCustodian).toEqual({ email: 'alice@acme.example', displayName: 'Alice Doe' });
    expect(req.scope.dateRange).toEqual({ kind: 'all_time' });
    expect(req.scope.uploads?.evidenceItemIds).toEqual(['up-11111111', 'up-22222222']);
    expect(req.scope.email).toBeUndefined();
    expect(req.scope.audit).toBeUndefined();
  });

  it('buildCreateRequest throws with no uploads or an invalid custodian email', () => {
    const s = uploadWizard();
    expect(() => buildCreateRequest(s)).toThrow();
    const withUpload = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    expect(() => buildCreateRequest(withUpload)).toThrow(); // custodian email still empty
  });

  it('resume round-trips the upload slice', () => {
    let s = uploadWizard();
    s = wizardReducer(s, { type: 'addUpload', upload: PST_UPLOAD });
    s = wizardReducer(s, {
      type: 'patch',
      patch: { uploadCustodian: { email: 'alice@acme.example', displayName: 'Alice Doe' } },
    });
    s = wizardReducer(s, { type: 'next' });
    const resumed = hydrateWizard(serializeWizard(s), 'other-key-abcdefgh');
    expect(resumed).toEqual(s);
    expect(resumed.uploads[0]?.sha256).toBe(PST_UPLOAD.sha256);
  });
});

describe('v1 → v2 storage migration', () => {
  it('migrates a v1 payload by adding an empty upload slice', () => {
    const v2 = freshWizard(KEY);
    const legacy: Record<string, unknown> = {
      ...v2,
      v: 1,
      name: 'Resumed run',
      step: 2,
      maxStepReached: 3,
    };
    delete legacy['uploads'];
    delete legacy['uploadCustodian'];
    const resumed = hydrateWizard(JSON.stringify(legacy), 'other-key-abcdefgh');
    expect(resumed.v).toBe(2);
    expect(resumed.name).toBe('Resumed run');
    expect(resumed.step).toBe(2);
    expect(resumed.idempotencyKey).toBe(KEY);
    expect(resumed.uploads).toEqual([]);
    expect(resumed.uploadCustodian).toEqual({ email: '', displayName: '' });
  });

  it('discards unknown or future versions safely', () => {
    expect(hydrateWizard(JSON.stringify({ v: 99 }), KEY).idempotencyKey).toBe(KEY);
    expect(hydrateWizard(JSON.stringify({ v: 1, garbage: true }), KEY).step).toBe(0);
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
    s = wizardReducer(s, {
      type: 'patch',
      patch: { sources: { email: true, drive: true, audit: false } },
    });
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

describe('audit source', () => {
  function auditGoogleWizard(): WizardState {
    let s = freshWizard(KEY);
    s = wizardReducer(s, {
      type: 'patch',
      patch: {
        name: 'Audit sweep',
        provider: 'google',
        connectorAccountId: '4f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b',
        connectorMode: 'organization',
        sources: { email: false, drive: false, audit: true },
        custodians: [],
      },
    });
    return s;
  }

  it('requires an organization-mode connector for audit', () => {
    let s = auditGoogleWizard();
    s = wizardReducer(s, { type: 'patch', patch: { connectorMode: 'delegated' } });
    const errors = validateStep(s, 2 /* STEP_SOURCES */);
    expect(errors.join(' ')).toContain('organization-mode');
  });

  it('an audit-only collection needs no custodian', () => {
    const s = auditGoogleWizard();
    expect(validateStep(s, STEP_CUSTODIANS)).toEqual([]);
  });

  it('requires an audit scope before advancing past scope', () => {
    const s = auditGoogleWizard();
    // Nothing configured yet.
    expect(validateStep(s, STEP_SCOPE).length).toBeGreaterThan(0);
    const configured = wizardReducer(s, {
      type: 'patchAudit',
      patch: { googleReportApplications: ['login', 'drive'] },
    });
    expect(validateStep(configured, STEP_SCOPE)).toEqual([]);
  });

  it('compiles the Google audit scope into the create request', () => {
    let s = auditGoogleWizard();
    s = wizardReducer(s, {
      type: 'patchAudit',
      patch: {
        googleReportApplications: ['login', 'drive'],
        includeVault: true,
        vaultMatterIdsText: 'matter-1, matter-2',
        actorFilterText: 'alice@example.com',
      },
    });
    const req = buildCreateRequest(s);
    expect(req.sources).toEqual(['audit']);
    expect(req.custodianIds).toEqual([]);
    expect(req.scope.audit?.google?.reportApplications).toEqual(['login', 'drive']);
    expect(req.scope.audit?.google?.includeVault).toBe(true);
    expect(req.scope.audit?.google?.vaultMatterIds).toEqual(['matter-1', 'matter-2']);
    expect(req.scope.audit?.actorFilter).toEqual(['alice@example.com']);
    expect(req.scope.audit?.microsoft).toBeUndefined();
  });

  it('compiles the Microsoft audit content types and Graph toggles', () => {
    let s = freshWizard(KEY);
    s = wizardReducer(s, {
      type: 'patch',
      patch: {
        name: 'MS audit',
        provider: 'microsoft',
        connectorAccountId: '4f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b',
        connectorMode: 'organization',
        sources: { email: false, drive: false, audit: true },
        custodians: [],
      },
    });
    s = wizardReducer(s, {
      type: 'patchAudit',
      patch: { msContentTypes: ['Audit.Exchange'], includeGraphSignins: true },
    });
    const req = buildCreateRequest(s);
    expect(req.scope.audit?.microsoft?.managementContentTypes).toEqual(['Audit.Exchange']);
    expect(req.scope.audit?.microsoft?.includeGraphSignins).toBe(true);
    expect(req.scope.audit?.google).toBeUndefined();
  });
});

describe('IMAP collections', () => {
  function imapWizard(): WizardState {
    let s = freshWizard(KEY);
    s = wizardReducer(s, {
      type: 'patch',
      patch: {
        name: 'Yahoo mailbox sweep',
        provider: 'imap',
        connectorAccountId: '4f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b',
        connectorMode: 'delegated',
        sources: { email: true, drive: false, audit: false },
        custodians: [{ id: '2f9a4f4e-7b8b-4b1c-9a3e-1c2d3e4f5a6b', email: 'someone@yahoo.com' }],
      },
    });
    return s;
  }

  it('accepts an email-only IMAP collection', () => {
    expect(validateStep(imapWizard(), STEP_SOURCES)).toEqual([]);
  });

  it('refuses drive on an IMAP connector, naming the reason', () => {
    // IMAP is mail. Letting drive through would produce a collection that
    // reports a source it never looked at.
    const s = wizardReducer(imapWizard(), {
      type: 'patch',
      patch: { sources: { email: true, drive: true, audit: false } },
    });
    const errors = validateStep(s, STEP_SOURCES);
    expect(errors.join(' ')).toMatch(/IMAP/i);
    expect(errors.join(' ')).toMatch(/mail/i);
  });

  it('refuses audit logs on an IMAP connector', () => {
    const s = wizardReducer(imapWizard(), {
      type: 'patch',
      patch: { sources: { email: false, drive: false, audit: true } },
    });
    expect(validateStep(s, STEP_SOURCES).length).toBeGreaterThan(0);
  });

  it('builds a request with the email source only', () => {
    const s = wizardReducer(imapWizard(), {
      type: 'patchScope',
      patch: { emailAllFolders: true },
    });
    const body = buildCreateRequest(s);
    expect(body.sources).toEqual(['email']);
    expect(body.scope.drive).toBeUndefined();
    expect(body.scope.audit).toBeUndefined();
  });
});

describe('dropbox collections', () => {
  function dropboxState() {
    return {
      ...freshWizard('idem-dropbox-1'),
      provider: 'dropbox' as const,
      name: 'Dropbox files',
      connectorAccountId: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      connectorMode: 'delegated' as const,
    };
  }

  it('can be chosen as a provider at all', () => {
    // Without this the connector exists, the account can be connected, and the
    // wizard still cannot start a collection with it.
    const state = { ...dropboxState(), sources: { email: false, drive: true, audit: false } };
    expect(validateStep(state, STEP_TYPE)).toEqual([]);
  });

  it('collects files', () => {
    const state = { ...dropboxState(), sources: { email: false, drive: true, audit: false } };
    expect(validateStep(state, STEP_SOURCES)).toEqual([]);
  });

  it('refuses mail, because Dropbox has no mailbox', () => {
    // The mirror of the IMAP rule. Allowing it would produce a collection that
    // claims a source it never looked at.
    const state = { ...dropboxState(), sources: { email: true, drive: true, audit: false } };
    const errors = validateStep(state, STEP_SOURCES);
    expect(errors.join(' ')).toMatch(/files only|no mailbox/i);
  });

  it('refuses the team event log on a personal (delegated) connector', () => {
    // Not a policy choice: Dropbox itself refuses a personal account's token
    // with USER_AUTH_NOT_ALLOWED, "This token is not associated with a team".
    const state = { ...dropboxState(), sources: { email: false, drive: true, audit: true } };
    const errors = validateStep(state, STEP_SOURCES);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/business team/i);
    // Must never claim the provider has no audit log — that is simply false.
    expect(errors.join(' ')).not.toMatch(/has no (provider )?audit log/i);
  });

  it('allows the team event log on an organization connector', () => {
    const state = {
      ...dropboxState(),
      connectorMode: 'organization' as const,
      sources: { email: false, drive: false, audit: true },
    };
    expect(validateStep(state, STEP_SOURCES)).toEqual([]);
  });

  it('still requires at least one source', () => {
    const state = { ...dropboxState(), sources: { email: false, drive: false, audit: false } };
    expect(validateStep(state, STEP_SOURCES).length).toBeGreaterThan(0);
  });
});

describe('sourcesForProvider', () => {
  const ALL = { email: true, drive: true, audit: true };

  /**
   * Reported from staging: choosing Dropbox left "Email" ticked from the
   * default, disabled so it could not be unticked, and validation then refused
   * to advance. A dead end with no way out but starting over.
   */
  it('clears mail when the provider has none, but keeps what it does have', () => {
    // Dropbox has files and, for a Business team, an event log. Only mail is
    // genuinely absent, so only mail should be cleared.
    expect(sourcesForProvider('dropbox', ALL)).toEqual({
      email: false,
      drive: true,
      audit: true,
    });
  });

  it('clears files and audit when the provider is mail only', () => {
    expect(sourcesForProvider('imap', ALL)).toEqual({ email: true, drive: false, audit: false });
  });

  it('always leaves at least one source selected', () => {
    // The other half of the dead end: clearing the only ticked box would fail
    // validation with "select at least one source" and be just as stuck.
    const fromMailOnly = { email: true, drive: false, audit: false };
    expect(sourcesForProvider('dropbox', fromMailOnly).drive).toBe(true);
    const fromFilesOnly = { email: false, drive: true, audit: false };
    expect(sourcesForProvider('imap', fromFilesOnly).email).toBe(true);
  });

  it('leaves a full provider’s choices alone', () => {
    for (const provider of ['microsoft', 'google'] as const) {
      expect(sourcesForProvider(provider, ALL)).toEqual(ALL);
    }
  });

  it('forces uploads to mail, which is all a PST contains', () => {
    expect(sourcesForProvider('upload', ALL)).toEqual({
      email: true,
      drive: false,
      audit: false,
    });
  });

  it('never produces a selection its own validator would reject', () => {
    // The property that matters: whatever the operator had ticked before, the
    // result must be something they can actually proceed with.
    const base = freshWizard('idem-clamp');
    for (const provider of ['microsoft', 'google', 'imap', 'dropbox', 'upload'] as const) {
      for (const before of [
        ALL,
        { email: true, drive: false, audit: false },
        { email: false, drive: true, audit: false },
        { email: false, drive: false, audit: true },
      ]) {
        const sources = sourcesForProvider(provider, before);
        const state = {
          ...base,
          provider,
          name: 'x',
          connectorAccountId: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
          connectorMode: 'organization' as const,
          sources,
          uploads: provider === 'upload' ? base.uploads : base.uploads,
        };
        const errors = validateStep(state, STEP_SOURCES);
        expect(errors, `${provider} / ${JSON.stringify(before)}`).toEqual([]);
      }
    }
  });
});
