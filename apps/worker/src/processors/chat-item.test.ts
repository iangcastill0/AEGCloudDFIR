import { describe, expect, it } from 'vitest';
import { canonicalJson } from './collection-fetch-item.js';
import { isoToSlackTs } from './collection-fetch-page.js';

/**
 * The stored bytes are the evidence and their SHA-256 is the chain of custody.
 * Two collections of the same Slack message must therefore hash identically —
 * an unstable hash would make an honest re-collection look like tampering.
 */
describe('canonicalJson', () => {
  it('sorts keys so the same message always hashes the same', () => {
    const a = canonicalJson({ user: 'U1', ts: '1.0', text: 'hi' });
    const b = canonicalJson({ text: 'hi', ts: '1.0', user: 'U1' });
    expect(a).toBe(b);
  });

  it('sorts nested keys too', () => {
    const a = canonicalJson({ edited: { user: 'U1', ts: '2.0' } });
    const b = canonicalJson({ edited: { ts: '2.0', user: 'U1' } });
    expect(a).toBe(b);
  });

  it('preserves array order, which carries meaning', () => {
    // Reply order and attachment order are facts about the message.
    expect(canonicalJson({ files: [{ id: 'F2' }, { id: 'F1' }] })).toBe(
      '{"files":[{"id":"F2"},{"id":"F1"}]}',
    );
  });

  it('loses nothing from the provider payload', () => {
    // The value of preserving the raw message is that it is complete. A field
    // this version does not understand must still be in the stored bytes.
    const raw = { ts: '1.0', some_future_field: { nested: true }, blocks: [1, 2] };
    expect(JSON.parse(canonicalJson(raw))).toEqual(raw);
  });
});

describe('isoToSlackTs', () => {
  it('converts a date bound to the epoch seconds Slack expects', () => {
    // Slack's oldest/latest are epoch seconds, not ISO. Sending an ISO string
    // makes Slack ignore the bound SILENTLY: the collection then covers the
    // whole channel while the manifest says it was date-scoped, which is a
    // false statement about what was collected.
    expect(isoToSlackTs('2026-01-01T00:00:00.000Z')).toBe('1767225600.000000');
  });

  it('keeps microsecond precision, which is how Slack pages', () => {
    expect(isoToSlackTs('2026-01-01T00:00:00.123Z')).toBe('1767225600.123000');
  });
});
