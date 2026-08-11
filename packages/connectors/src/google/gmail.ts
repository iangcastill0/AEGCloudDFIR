/**
 * Gmail connector. Labels are exposed through the folder vocabulary; the
 * native is the raw RFC822 obtained via format=raw (base64url). Incremental
 * sync uses users.history.list keyed by historyId; an expired checkpoint
 * (HTTP 404) surfaces as HistoryExpiredError so the caller starts a
 * reconciliation scan and records it.
 */
import { z } from 'zod';
import { ensureOk, providerFetch } from '../http.js';
import {
  HistoryExpiredError,
  ProviderApiError,
  type EmailConnector,
  type EmailListEntry,
  type EmailListPage,
  type FetchedEmail,
  type ListMessagesOptions,
  type MailFolderDiscovery,
} from '../types.js';
import {
  GOOGLE_SELF_UID,
  googleFetchOptions,
  normalizeBaseUrl,
  type GoogleConnectorOptions,
} from './common.js';

const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  messagesTotal: z.number().optional(),
});

const labelListSchema = z.object({ labels: z.array(labelSchema).default([]) });

const messageRefSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
});

const messageListSchema = z.object({
  messages: z.array(messageRefSchema).default([]),
  nextPageToken: z.string().optional(),
});

const rawMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  historyId: z.string().optional(),
  raw: z.string(),
});

const historyMessageSchema = z.object({
  message: z.object({
    id: z.string(),
    threadId: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
  }),
});

const historyPageSchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z.array(historyMessageSchema).optional(),
        messagesDeleted: z.array(historyMessageSchema).optional(),
      }),
    )
    .default([]),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
});

/** Gmail search-operator date (UTC): YYYY/MM/DD. */
export function gmailDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new ProviderApiError('invalid date supplied for Gmail query', { status: 0 });
  }
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}/${mm}/${dd}`;
}

/** Sentinel folder id for account-level Gmail history sync. */
export const GMAIL_ACCOUNT_FOLDER = '__account__';

export class GmailConnector implements EmailConnector {
  private readonly base: string;

  constructor(private readonly options: GoogleConnectorOptions) {
    this.base = normalizeBaseUrl(options.googleApiBaseUrl);
  }

  private gmailUrl(pathSuffix: string): string {
    return `${this.base}/gmail/v1/users/${GOOGLE_SELF_UID}${pathSuffix}`;
  }

  private async get(url: string): Promise<Response> {
    return providerFetch(url, { method: 'GET' }, googleFetchOptions(this.options));
  }

  async listMailFolders(_custodian: string): Promise<MailFolderDiscovery> {
    const res = await ensureOk(await this.get(this.gmailUrl('/labels')), 'listMailFolders');
    const parsed = labelListSchema.parse(await res.json());
    return {
      folders: parsed.labels.map((label) => ({
        id: label.id,
        displayName: label.name,
        wellKnown: label.type === 'system' ? label.id : undefined,
        totalItemCount: label.messagesTotal,
        // Gmail nests labels with '/' in the name itself.
        path: label.name.startsWith('/') ? label.name : `/${label.name}`,
      })),
      exceptions: [],
    };
  }

  async listMessages(
    _custodian: string,
    folderIdOrLabel: string,
    opts: ListMessagesOptions = {},
  ): Promise<EmailListPage> {
    const u = new URL(this.gmailUrl('/messages'));
    u.searchParams.set('maxResults', '100');
    if (folderIdOrLabel !== '' && folderIdOrLabel !== GMAIL_ACCOUNT_FOLDER) {
      u.searchParams.set('labelIds', folderIdOrLabel);
    }
    const q: string[] = [];
    if (opts.since !== undefined) q.push(`after:${gmailDate(opts.since)}`);
    if (opts.until !== undefined) q.push(`before:${gmailDate(opts.until)}`);
    if (q.length > 0) u.searchParams.set('q', q.join(' '));
    // Spam/trash are included ONLY when the caller selected them.
    if (opts.includeDeleted === true) u.searchParams.set('includeSpamTrash', 'true');
    if (opts.cursor !== undefined) u.searchParams.set('pageToken', opts.cursor);

    const res = await ensureOk(await this.get(u.toString()), 'listMessages');
    const page = messageListSchema.parse(await res.json());
    return {
      items: page.messages.map((m) => ({
        providerItemId: m.id,
        threadId: m.threadId,
        labelIds: folderIdOrLabel !== GMAIL_ACCOUNT_FOLDER ? [folderIdOrLabel] : undefined,
      })),
      nextCursor: page.nextPageToken,
    };
  }

  async fetchMessage(_custodian: string, providerItemId: string): Promise<FetchedEmail> {
    const res = await ensureOk(
      await this.get(this.gmailUrl(`/messages/${encodeURIComponent(providerItemId)}?format=raw`)),
      'fetchMessage',
    );
    const parsed = rawMessageSchema.parse(await res.json());
    const rfc822 = new Uint8Array(Buffer.from(parsed.raw, 'base64url'));
    return {
      providerItemId: parsed.id,
      rfc822,
      metadata: {
        threadId: parsed.threadId,
        labelIds: parsed.labelIds,
        receivedAt:
          parsed.internalDate !== undefined
            ? new Date(Number(parsed.internalDate)).toISOString()
            : undefined,
        historyId: parsed.historyId,
      },
    };
  }

  /**
   * Account-level history sync (folderId is ignored; pass GMAIL_ACCOUNT_FOLDER).
   * Aggregates messagesAdded/messagesDeleted across all history pages and
   * returns the latest historyId as deltaCursor.
   */
  async getMailDelta(
    _custodian: string,
    _folderId: string,
    deltaCursor?: string,
  ): Promise<EmailListPage> {
    if (deltaCursor === undefined || deltaCursor === '') {
      throw new ProviderApiError(
        'gmail incremental sync requires a starting historyId checkpoint',
        { status: 0 },
      );
    }
    const aggregated = new Map<string, EmailListEntry>();
    let latestHistoryId = deltaCursor;
    let pageToken: string | undefined;

    do {
      const u = new URL(this.gmailUrl('/history'));
      u.searchParams.set('startHistoryId', deltaCursor);
      u.searchParams.set('maxResults', '100');
      if (pageToken !== undefined) u.searchParams.set('pageToken', pageToken);
      const res = await this.get(u.toString());
      if (res.status === 404) {
        throw new HistoryExpiredError(
          'gmail history checkpoint expired; start a reconciliation scan and record it',
        );
      }
      await ensureOk(res, 'getMailDelta');
      const page = historyPageSchema.parse(await res.json());
      for (const record of page.history) {
        for (const added of record.messagesAdded ?? []) {
          aggregated.set(added.message.id, {
            providerItemId: added.message.id,
            threadId: added.message.threadId,
            labelIds: added.message.labelIds,
          });
        }
        for (const removed of record.messagesDeleted ?? []) {
          aggregated.set(removed.message.id, {
            providerItemId: removed.message.id,
            threadId: removed.message.threadId,
            deleted: true,
          });
        }
      }
      if (page.historyId !== undefined) latestHistoryId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    return { items: [...aggregated.values()], deltaCursor: latestHistoryId };
  }
}
