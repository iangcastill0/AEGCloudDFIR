import { describe, expect, it } from 'vitest';
import { composeQuery } from './hooks.js';

/**
 * The rail's filters are appended to the user's text as query-language clauses,
 * so they have to be written in the same language — and they have to name fields
 * that exist. Both were wrong before: `type` is not a field at all, so choosing
 * a Source failed every search with "Unknown field".
 */
describe('composeQuery', () => {
  it('uses kind, not type, for the Email source filter', () => {
    const q = composeQuery({ queryText: '', source: 'email' });
    expect(q).toContain('kind:');
    expect(q).not.toContain('type:');
  });

  it('uses kind for the Drive source filter', () => {
    expect(composeQuery({ queryText: '', source: 'drive' })).toBe('kind:"file"');
  });

  it('writes clauses in the advanced language when that is selected', () => {
    // A mix of languages is rejected by whichever parser runs, so this is not
    // cosmetic: the whole query fails.
    const q = composeQuery({
      queryText: 'body CONTAINS insurance',
      syntax: 'advanced',
      source: 'drive',
      custodianEmail: 'dana@example.com',
    });
    expect(q).toBe(
      '(body CONTAINS insurance) AND custodian IS "dana@example.com" AND kind IS "file"',
    );
  });

  it('writes clauses in the simple language by default', () => {
    const q = composeQuery({
      queryText: 'insurance',
      source: 'drive',
      custodianEmail: 'dana@example.com',
    });
    expect(q).toBe('(insurance) AND custodian:"dana@example.com" AND kind:"file"');
  });

  it('combines several facet values with OR inside one group', () => {
    const q = composeQuery({ queryText: '', facetFilters: { extension: ['pdf', 'docx'] } });
    expect(q).toBe('(ext:"pdf" OR ext:"docx")');
  });

  it('strips quotes from facet values so they cannot break out of the clause', () => {
    const q = composeQuery({ queryText: '', facetFilters: { extension: ['pd"f'] } });
    expect(q).toBe('ext:"pdf"');
  });

  it('is empty when nothing is set, which the API reads as browse-all', () => {
    expect(composeQuery({ queryText: '' })).toBe('');
  });
});
