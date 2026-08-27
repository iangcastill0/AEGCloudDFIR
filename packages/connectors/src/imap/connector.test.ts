import { describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { ImapEmailConnector, type ImapConnectorOptions } from './connector';
import { ProviderAuthError } from '../types.js';
import { encodeUidCursor } from './uid';

interface FakeState {
  mailboxes?: { path: string; delimiter: string; flags: string[] }[];
  uidValidity?: number;
  uidNext?: number;
  searchResult?: number[] | false;
  source?: Buffer;
  connectFails?: boolean;
}

function fakeClient(state: FakeState) {
  const calls = {
    connect: vi.fn(async () => {
      if (state.connectFails === true) throw new Error('AUTHENTICATIONFAILED');
    }),
    logout: vi.fn(async () => undefined),
    list: vi.fn(async () =>
      (state.mailboxes ?? []).map((m) => ({
        path: m.path,
        delimiter: m.delimiter,
        flags: new Set(m.flags),
      })),
    ),
    on: vi.fn(),
    close: vi.fn(),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    search: vi.fn(async () => state.searchResult ?? []),
    fetchOne: vi.fn(async () => ({
      source: state.source ?? Buffer.from('From: a@b.com\r\n\r\nhi', 'utf8'),
      envelope: { subject: 'Q3', messageId: '<abc@x>', date: new Date('2026-03-04T05:06:07Z') },
      flags: new Set(['\\Seen']),
    })),
  };
  const client = {
    ...calls,
    get mailbox() {
      return { uidValidity: state.uidValidity ?? 1000, uidNext: state.uidNext ?? 10_000 };
    },
  } as unknown as ImapFlow;
  return { client, calls };
}

function connector(state: FakeState, over: Partial<ImapConnectorOptions> = {}) {
  const fake = fakeClient(state);
  const options: ImapConnectorOptions = {
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    username: 'someone@yahoo.com',
    password: 'app-password',
    clientFactory: () => fake.client,
    ...over,
  };
  return { conn: new ImapEmailConnector(options), calls: fake.calls };
}

describe('ImapEmailConnector.listMailFolders', () => {
  it('returns selectable mailboxes and reports the ones it skipped', async () => {
    const { conn } = connector({
      mailboxes: [
        { path: 'INBOX', delimiter: '/', flags: [] },
        { path: 'Archive', delimiter: '/', flags: ['\\Noselect'] },
        { path: 'Trash', delimiter: '/', flags: ['\\Trash'] },
      ],
    });
    const result = await conn.listMailFolders('me');
    expect(result.folders.map((f) => f.id)).toEqual(['INBOX', 'Trash']);
    expect(result.folders[1]?.wellKnown).toBe('deleteditems');
    expect(result.exceptions).toHaveLength(1);
  });
});

describe('ImapEmailConnector.listMessages', () => {
  it('gives each message an id that carries its mailbox', async () => {
    // A UID means nothing without the mailbox it came from, and fetch has to be
    // able to reopen that mailbox from the id alone.
    const { conn } = connector({ searchResult: [7, 5, 9] });
    const page = await conn.listMessages('me', 'INBOX');
    expect(page.items.map((i) => i.providerItemId)).toEqual(['INBOX:5', 'INBOX:7', 'INBOX:9']);
  });

  it('hands back a cursor while the mailbox has more UIDs to walk', async () => {
    const { conn } = connector({ searchResult: [1], uidNext: 10_000 });
    const page = await conn.listMessages('me', 'INBOX');
    expect(page.nextCursor).toBeDefined();
  });

  it('stops offering a cursor once the walk has passed the last UID', async () => {
    // Without this the walk never ends and the collection never finalizes.
    const { conn } = connector({ searchResult: [1], uidNext: 10 });
    const page = await conn.listMessages('me', 'INBOX');
    expect(page.nextCursor).toBeUndefined();
  });

  it('walks from the start again when the mailbox generation changed', async () => {
    // A stale UID after a UIDVALIDITY change would skip mail and still look
    // like a complete collection.
    const { conn, calls } = connector({ uidValidity: 2000, searchResult: [] });
    await conn.listMessages('me', 'INBOX', {
      cursor: encodeUidCursor({ uidValidity: '1000', lastUid: 5000 }),
    });
    const query = calls.search.mock.calls[0]?.[0] as { uid: string };
    expect(query.uid.startsWith('1:')).toBe(true);
  });

  it('treats a failed search as an error, not as an empty mailbox', async () => {
    const { conn } = connector({ searchResult: false });
    await expect(conn.listMessages('me', 'INBOX')).rejects.toThrow(/search failed/);
  });
});

describe('ImapEmailConnector.fetchMessage', () => {
  it('reopens the mailbox from the id and returns the raw bytes', async () => {
    const raw = Buffer.from('From: a@b.com\r\nSubject: Q3\r\n\r\nbody', 'utf8');
    const { conn, calls } = connector({ source: raw });
    const fetched = await conn.fetchMessage('me', 'INBOX.Projects:42');

    expect(calls.getMailboxLock).toHaveBeenCalledWith('INBOX.Projects');
    expect(calls.fetchOne.mock.calls[0]?.[0]).toBe('42');
    expect(Buffer.from(fetched.rfc822).equals(raw)).toBe(true);
    expect(fetched.metadata.folderId).toBe('INBOX.Projects');
    expect(fetched.metadata.internetMessageId).toBe('<abc@x>');
  });

  it('asks for the message source, which imapflow sends as BODY.PEEK', async () => {
    // PEEK is the whole point: a plain BODY[] fetch sets \Seen and would alter
    // the custodian's mailbox. Verified against imapflow's fetch command, which
    // routes `source` through setBodyPeek.
    const { conn, calls } = connector({});
    await conn.fetchMessage('me', 'INBOX:1');
    const query = calls.fetchOne.mock.calls[0]?.[1] as { source?: boolean };
    expect(query.source).toBe(true);
  });
});

describe('ImapEmailConnector connection failures', () => {
  it('reports a refused login as a provider auth error, naming the host', async () => {
    const { conn } = connector({ connectFails: true });
    await expect(conn.listMailFolders('me')).rejects.toThrow(ProviderAuthError);
    await expect(conn.listMailFolders('me')).rejects.toThrow(/imap\.mail\.yahoo\.com/);
  });

  it('never puts the password in the error', async () => {
    // The message goes to a log and to the operator's screen. Asserted by
    // catching the error and reading it, because a matcher-in-toThrow reads as a
    // check while actually passing on almost anything.
    const { conn } = connector({ connectFails: true }, { password: 'super-secret-app-pw' });
    let message = '';
    try {
      await conn.listMailFolders('me');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('super-secret-app-pw');
    expect(message).toContain('someone@yahoo.com');
  });
});

describe('socket lifecycle', () => {
  /**
   * Found against a real server, not imagined. Three refused logins behaved
   * correctly, then a stray "Socket timeout" was emitted on an abandoned
   * ImapFlow instance seconds later and, with no 'error' listener, Node killed
   * the process. In the worker that is a dead process mid-collection — and a
   * dead worker is what leaves items stuck in "fetching" with no failure
   * recorded.
   */
  it('listens for error so a late socket fault cannot crash the process', async () => {
    const { conn, calls } = connector({
      mailboxes: [{ path: 'INBOX', delimiter: '/', flags: [] }],
    });
    await conn.listMailFolders('me');
    expect(calls.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('closes the socket after a failed connect, so it cannot time out later', async () => {
    const { conn, calls } = connector({ connectFails: true });
    await expect(conn.listMailFolders('me')).rejects.toThrow(ProviderAuthError);
    expect(calls.close).toHaveBeenCalled();
  });

  it('closes the socket after successful work too', async () => {
    const { conn, calls } = connector({ mailboxes: [] });
    await conn.listMailFolders('me');
    expect(calls.logout).toHaveBeenCalled();
    expect(calls.close).toHaveBeenCalled();
  });
});
