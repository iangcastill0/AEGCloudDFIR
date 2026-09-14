import { describe, expect, it } from 'vitest';
import { autoCaseDescription, autoCaseName } from './auto-case.js';

const AT = new Date('2026-09-11T14:30:00.000Z');

describe('autoCaseName', () => {
  it('carries the collection name so the two are recognisable as one job', () => {
    expect(autoCaseName('Winder — John Rorke mailbox', AT)).toBe(
      'Winder — John Rorke mailbox (2026-09-11)',
    );
  });

  it('dates the case, because the same mailbox gets collected again', () => {
    // Two collections of one custodian a month apart would otherwise produce
    // two identically named cases, indistinguishable in a list.
    const a = autoCaseName('Rorke mailbox', new Date('2026-09-11T00:00:00Z'));
    const b = autoCaseName('Rorke mailbox', new Date('2026-10-11T00:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('stays within the 200-character limit the schema allows', () => {
    const name = autoCaseName('x'.repeat(500), AT);
    expect(name.length).toBeLessThanOrEqual(200);
  });

  it('truncates the NAME and never the date', () => {
    // A shortened name is still recognisable. A half-written date is a lie.
    const name = autoCaseName('y'.repeat(500), AT);
    expect(name.endsWith(' (2026-09-11)')).toBe(true);
    expect(name).toContain('…');
  });

  it('falls back to a usable name when the collection has none', () => {
    // The contract requires a name, but a string of spaces passes min(1).
    expect(autoCaseName('   ', AT)).toBe('Collection (2026-09-11)');
  });

  it('trims surrounding whitespace rather than baking it into the case name', () => {
    expect(autoCaseName('  Rorke  ', AT)).toBe('Rorke (2026-09-11)');
  });
});

describe('autoCaseDescription', () => {
  it('records why the case exists, so nobody wonders later', () => {
    const text = autoCaseDescription('Rorke mailbox');
    expect(text).toContain('Rorke mailbox');
    expect(text).toContain('automatically');
  });
});
