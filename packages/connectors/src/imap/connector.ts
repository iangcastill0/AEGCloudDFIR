/**
 * IMAP email connector.
 *
 * Exists because Microsoft Graph and Gmail can only see mailboxes their own
 * companies host. A Yahoo mailbox — or any host offering IMAP — is invisible to
 * both, and a Microsoft account signed in with a Yahoo address returns an empty
 * Outlook mailbox rather than that person's mail.
 *
 * IMAP is a better source than either API in one respect: `BODY.PEEK[]` returns
 * the original RFC822 bytes, so the preserved evidence is the message as the
 * server holds it, not a re-serialization. PEEK matters — a plain BODY[] fetch
 * sets \Seen and would alter the custodian's mailbox, which a forensic
 * collection must never do.
 *
 * Everything with a rule in it (UID paging, UIDVALIDITY, folder mapping) lives in
 * uid.ts and folders.ts and is tested without a server. This file is the thin
 * layer that talks to one.
 */
import { ImapFlow, type ListResponse } from 'imapflow';
import { ProviderAuthError } from '../types.js';
import type {
  EmailConnector,
  EmailListPage,
  FetchedEmail,
  ListMessagesOptions,
  MailFolderDiscovery,
} from '../types.js';
import { mapMailboxes, type RawMailbox } from './folders.js';
import {
  decodeUidCursor,
  encodeUidCursor,
  nextUidRange,
  searchCriteria,
  type UidCursor,
} from './uid.js';

export interface ImapConnectorOptions {
  host: string;
  port: number;
  /** Implicit TLS (993). False means STARTTLS on 143. */
  secure: boolean;
  username: string;
  /**
   * App password, not the account password. Yahoo, Gmail and iCloud all refuse
   * the account password for IMAP and require a generated one.
   */
  password: string;
  /** Overridden in tests. */
  clientFactory?: (opts: ImapConnectorOptions) => ImapFlow;
}

function buildClient(options: ImapConnectorOptions): ImapFlow {
  if (options.clientFactory !== undefined) return options.clientFactory(options);
  return new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.username, pass: options.password },
    // The library's own chatter is not our log; failures surface as thrown
    // errors and are recorded by the caller.
    logger: false,
  });
}

/** IMAP has no per-account id; the login name is the identity. */
export class ImapEmailConnector implements EmailConnector {
  constructor(private readonly options: ImapConnectorOptions) {}

  /** One connection per call: a collection is long, and a held socket is not. */
  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = buildClient(this.options);
    try {
      await client.connect();
    } catch (err) {
      // A bad app password and an unreachable host are different problems for
      // the operator, but both arrive here as a connect failure.
      throw new ProviderAuthError(
        `IMAP connect failed for ${this.options.username} at ${this.options.host}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {
        // Losing the connection after the work is done changes nothing.
      });
    }
  }

  async listMailFolders(): Promise<MailFolderDiscovery> {
    return this.withClient(async (client) => {
      const listed: ListResponse[] = await client.list();
      const boxes: RawMailbox[] = listed.map((box) => ({
        path: box.path,
        delimiter: box.delimiter,
        flags: box.flags,
      }));
      return mapMailboxes(boxes);
    });
  }

  async listMessages(
    _custodian: string,
    folderId: string,
    opts: ListMessagesOptions = {},
  ): Promise<EmailListPage> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderId);
      try {
        const mailbox = client.mailbox;
        if (typeof mailbox === 'boolean') {
          throw new Error(`mailbox ${folderId} could not be opened`);
        }
        const uidValidity = String(mailbox.uidValidity);
        const cursor: UidCursor | null =
          opts.cursor === undefined ? null : decodeUidCursor(opts.cursor);
        const range = nextUidRange({ uidValidity, cursor });

        const searched = await client.search(
          { uid: `${String(range.from)}:${String(range.to)}`, ...searchCriteria(opts) },
          { uid: true },
        );
        // imapflow returns false when the mailbox could not be searched, which
        // is not the same as "no messages matched" and must not read as empty.
        if (searched === false) {
          throw new Error(`search failed in mailbox ${folderId}`);
        }
        const found = [...searched].sort((a: number, b: number) => a - b);

        // The id carries its mailbox: a UID alone is meaningless elsewhere.
        const items = found.map((uid: number) => ({
          providerItemId: `${folderId}:${String(uid)}`,
          folderId,
        }));

        // The window is advanced whether or not it held messages: gaps in UID
        // space are normal (deleted mail), and stopping at an empty window would
        // end the walk early and report a complete collection.
        const exhausted = range.to >= Number(mailbox.uidNext ?? 0) - 1;
        const page: EmailListPage = { items };
        if (!exhausted) {
          page.nextCursor = encodeUidCursor({ uidValidity, lastUid: range.to });
        }
        return page;
      } finally {
        lock.release();
      }
    });
  }

  async fetchMessage(_custodian: string, providerItemId: string): Promise<FetchedEmail> {
    // providerItemId is 'folderPath:uid'; the UID alone is meaningless without
    // its mailbox.
    const split = providerItemId.lastIndexOf(':');
    const folderId = split === -1 ? 'INBOX' : providerItemId.slice(0, split);
    const uid = split === -1 ? providerItemId : providerItemId.slice(split + 1);

    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(folderId);
      try {
        // PEEK, not BODY[]: fetching must not mark the custodian's mail as read.
        const message = await client.fetchOne(
          uid,
          { source: true, envelope: true, flags: true },
          { uid: true },
        );
        if (message === false || message.source === undefined) {
          throw new Error(`message ${providerItemId} was not returned by the server`);
        }
        const envelope = message.envelope;
        return {
          providerItemId,
          rfc822: message.source,
          metadata: {
            folderId,
            ...(envelope?.subject === undefined ? {} : { subject: envelope.subject }),
            ...(envelope?.messageId === undefined ? {} : { internetMessageId: envelope.messageId }),
            ...(envelope?.date === undefined ? {} : { sentAt: envelope.date.toISOString() }),
            ...(message.flags === undefined
              ? {}
              : { isRead: message.flags.has('\\Seen'), flags: { imap: [...message.flags] } }),
          },
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * IMAP has no delta. The honest answer is "walk from where you were", which is
   * exactly what listMessages does with a cursor — and a changed UIDVALIDITY
   * makes it start over rather than skip mail.
   */
  async getMailDelta(
    custodian: string,
    folderId: string,
    deltaCursor?: string,
  ): Promise<EmailListPage> {
    return this.listMessages(
      custodian,
      folderId,
      deltaCursor === undefined ? {} : { cursor: deltaCursor },
    );
  }
}
