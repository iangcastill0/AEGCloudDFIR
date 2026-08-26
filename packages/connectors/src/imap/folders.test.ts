import { describe, expect, it } from 'vitest';
import { mapMailboxes, type RawMailbox } from './folders';

function box(over: Partial<RawMailbox>): RawMailbox {
  return { path: 'INBOX', delimiter: '/', flags: new Set<string>(), ...over };
}

describe('mapMailboxes', () => {
  it('turns an IMAP path into a materialized path with a leading slash', () => {
    const { folders } = mapMailboxes([box({ path: 'Projects/2026/Q3' })]);
    expect(folders[0]?.path).toBe('/Projects/2026/Q3');
    expect(folders[0]?.displayName).toBe('Q3');
  });

  it('respects a server delimiter that is not a slash', () => {
    // Many servers use '.', and Courier-style servers prefix everything with
    // 'INBOX.'. Splitting on the wrong character would produce one long name.
    const { folders } = mapMailboxes([box({ path: 'INBOX.Projects.Q3', delimiter: '.' })]);
    expect(folders[0]?.path).toBe('/INBOX/Projects/Q3');
    expect(folders[0]?.displayName).toBe('Q3');
  });

  it('keeps the raw path as the id, because that is what SELECT needs', () => {
    const { folders } = mapMailboxes([box({ path: 'INBOX.Sent', delimiter: '.' })]);
    expect(folders[0]?.id).toBe('INBOX.Sent');
  });

  it('reads well-known folders from SPECIAL-USE flags, not from their names', () => {
    // A mailbox called "Papierkorb" is still the trash. Name matching would
    // miss it, and mis-labelling deleted items matters for a collection.
    const { folders } = mapMailboxes([
      box({ path: 'Papierkorb', flags: new Set(['\\Trash']) }),
      box({ path: 'Gesendet', flags: new Set(['\\Sent']) }),
      box({ path: 'Spamverdacht', flags: new Set(['\\Junk']) }),
    ]);
    expect(folders.map((f) => f.wellKnown)).toEqual(['deleteditems', 'sentitems', 'junkemail']);
  });

  it('treats INBOX as the inbox whatever its case, per RFC 3501', () => {
    const { folders } = mapMailboxes([box({ path: 'inbox' })]);
    expect(folders[0]?.wellKnown).toBe('inbox');
  });

  it('skips a mailbox flagged \\Noselect and says why', () => {
    // A container that cannot be selected holds no messages. Listing it as a
    // folder would make a collection look like it walked something it never did.
    const { folders, exceptions } = mapMailboxes([
      box({ path: 'Archive', flags: new Set(['\\Noselect']) }),
      box({ path: 'Archive/2026' }),
    ]);
    expect(folders.map((f) => f.id)).toEqual(['Archive/2026']);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.message).toContain('Archive');
  });

  it('reports a mailbox with no path instead of dropping it silently', () => {
    const { folders, exceptions } = mapMailboxes([box({ path: '' })]);
    expect(folders).toHaveLength(0);
    expect(exceptions).toHaveLength(1);
  });

  it('carries the message count when the server offers one', () => {
    const { folders } = mapMailboxes([box({ path: 'INBOX', exists: 99999 })]);
    expect(folders[0]?.totalItemCount).toBe(99999);
  });
});
