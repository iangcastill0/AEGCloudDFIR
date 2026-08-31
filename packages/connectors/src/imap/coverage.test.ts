import { describe, expect, it } from 'vitest';
import { coverageException } from './coverage.js';

/**
 * Measured against a real Yahoo mailbox on 2026-08-28. The server reported
 * 113,039 messages in INBOX and made exactly 10,000 available; nothing below
 * the window could be listed, searched by date, or fetched by explicit UID.
 * The product called that result "partial", which a reviewer would reasonably
 * read as our failure. These pin down saying whose limit it was.
 */
describe('coverageException', () => {
  it('reports the gap when the server withholds most of a mailbox', () => {
    const ex = coverageException({ path: 'INBOX', serverTotal: 113_039, exposed: 10_000 });
    expect(ex).not.toBeNull();
    expect(ex?.kind).toBe('unavailable_item');
    expect(ex?.providerItemId).toBe('INBOX');
    // Every number a reviewer needs, and no number they have to work out.
    expect(ex?.message).toContain('113,039');
    expect(ex?.message).toContain('10,000');
    expect(ex?.message).toContain('103,039');
  });

  it('names the mail server as the cause, not the collection', () => {
    const ex = coverageException({ path: 'INBOX', serverTotal: 113_039, exposed: 10_000 });
    expect(ex?.message).toMatch(/mail server/i);
    // Must never read as an unqualified success, and never blame the tool.
    expect(ex?.message).not.toMatch(/\bcomplete\b/i);
    expect(ex?.message).not.toMatch(/failed to collect|could not collect/i);
  });

  it('stays silent when the server offered everything it has', () => {
    expect(coverageException({ path: 'Sent', serverTotal: 145, exposed: 145 })).toBeNull();
    expect(coverageException({ path: 'Trash', serverTotal: 0, exposed: 0 })).toBeNull();
  });

  it('stays silent when mail arrived between the two measurements', () => {
    // STATUS then SELECT are two round trips. New mail in between makes the
    // second number larger, which is not a gap.
    expect(coverageException({ path: 'INBOX', serverTotal: 100, exposed: 103 })).toBeNull();
  });

  it('claims nothing when it could not measure', () => {
    // A missing count is not evidence of a gap. Inventing one would put a false
    // exception in a legal artefact.
    expect(coverageException({ path: 'INBOX', serverTotal: undefined, exposed: 10 })).toBeNull();
    expect(coverageException({ path: 'INBOX', serverTotal: 10, exposed: undefined })).toBeNull();
    expect(
      coverageException({ path: 'INBOX', serverTotal: undefined, exposed: undefined }),
    ).toBeNull();
  });

  it('reports even a small gap, because a silent one is the worse error', () => {
    const ex = coverageException({ path: 'Archive', serverTotal: 5, exposed: 3 });
    expect(ex).not.toBeNull();
    expect(ex?.message).toContain('2');
  });

  it('formats large numbers so they can be read at a glance', () => {
    const ex = coverageException({ path: 'INBOX', serverTotal: 1_234_567, exposed: 1_000 });
    expect(ex?.message).toContain('1,234,567');
    expect(ex?.message).toContain('1,233,567');
  });
});
