import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_STEPS,
  canAdvanceProduction,
  formatBates,
  freshProductionWizard,
  productionWizardReducer,
  validateProductionStep,
} from './production-wizard';
import { QUERY_EXAMPLES, checkQueryExample } from './query-help';

const KEY = 'prod-idempotency-key-1234';

describe('production wizard gating', () => {
  it('has ten steps per contract §12', () => {
    expect(PRODUCTION_STEPS).toHaveLength(10);
  });

  it('blocks step 1 without a name and step 2 without a selection', () => {
    const s = freshProductionWizard(KEY);
    expect(canAdvanceProduction(s)).toBe(false);
    const named = productionWizardReducer(s, { type: 'patchParams', patch: { name: 'Wave 1' } });
    const advanced = productionWizardReducer(named, { type: 'next' });
    expect(advanced.step).toBe(1);
    expect(canAdvanceProduction(advanced)).toBe(false); // no tags / saved searches yet
    expect(productionWizardReducer(advanced, { type: 'next' }).step).toBe(1);
  });

  it('rejects duplicate stamp positions and empty custom stamp text', () => {
    let s = freshProductionWizard(KEY);
    s = productionWizardReducer(s, {
      type: 'patchParams',
      patch: {
        stamps: [
          { position: 'bottom_right', kind: 'bates', text: '', priority: 5, addedMarginPoints: 0 },
          { position: 'bottom_right', kind: 'custom', text: '', priority: 5, addedMarginPoints: 0 },
        ],
      },
    });
    const errors = validateProductionStep(s, 5);
    expect(errors.join(' ')).toMatch(/position/);
    expect(errors.join(' ')).toMatch(/needs text/);
  });

  it('validates bates config bounds', () => {
    let s = freshProductionWizard(KEY);
    s = productionWizardReducer(s, {
      type: 'patchParams',
      patch: {
        bates: {
          prefix: 'bad prefix!',
          startNumber: 0,
          digits: 2,
          suffix: '',
          numbering: 'per_page',
        },
      },
    });
    expect(validateProductionStep(s, 7).length).toBeGreaterThanOrEqual(3);
  });

  it('idempotency key is stable across transitions', () => {
    let s = freshProductionWizard(KEY);
    s = productionWizardReducer(s, { type: 'patchParams', patch: { name: 'W' } });
    s = productionWizardReducer(s, { type: 'next' });
    s = productionWizardReducer(s, { type: 'back' });
    expect(s.idempotencyKey).toBe(KEY);
  });
});

describe('formatBates live preview', () => {
  it('pads to the configured digits with prefix and suffix', () => {
    expect(formatBates({ prefix: 'ACME', startNumber: 42, digits: 8, suffix: 'X' })).toBe(
      'ACME00000042X',
    );
    expect(formatBates({ prefix: '', startNumber: 7, digits: 4, suffix: '' }, 3)).toBe('0010');
  });
});

describe('query help examples', () => {
  it('every documented example passes the sanity checker', () => {
    expect(QUERY_EXAMPLES.length).toBeGreaterThanOrEqual(5);
    for (const example of QUERY_EXAMPLES) {
      expect(checkQueryExample(example.query)).toEqual([]);
      expect(example.description.length).toBeGreaterThan(0);
    }
  });

  it('the checker actually catches malformed queries', () => {
    expect(checkQueryExample('')).toContain('empty query');
    expect(checkQueryExample('subject:"unbalanced')).toContain('unbalanced quotes');
    expect(checkQueryExample('(a OR b')).toContain('unclosed parenthesis');
    expect(checkQueryExample('a OR b)')).toContain('unbalanced closing parenthesis');
  });
});
