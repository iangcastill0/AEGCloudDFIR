/**
 * Microsoft Graph mail connector (delegated and organization modes).
 *
 * Natives are the full RFC822 MIME from /messages/{id}/$value; API metadata
 * (participants incl. BCC when returned, internet headers, categories, flags,
 * conversation id, folder) is preserved alongside. Folder enumeration is
 * recursive, includes hidden folders and attempts the recoverable-items
 * deletions well-known folder, reporting permission failures as exceptions.
 */
import { z } from 'zod';
import { ensureOk, providerFetch } from '../http.js';
import {
  DeltaExpiredError,
  type ConnectorException,
  type DiscoveredMailFolder,
  type EmailAddressRef,
  type EmailApiMetadata,
  type EmailConnector,
  type EmailListEntry,
  type EmailListPage,
  type FetchedEmail,
  type ListMessagesOptions,
  type MailFolderDiscovery,
} from '../types.js';
import {
  graphFetchOptions,
  normalizeBaseUrl,
  userSegment,
  type GraphConnectorOptions,
} from './common.js';

const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

const MESSAGE_LIST_SELECT =
  'id,internetMessageId,conversationId,receivedDateTime,hasAttachments,categories,flag,isRead';

const MESSAGE_FULL_SELECT = [
  'id',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'sentDateTime',
  'receivedDateTime',
  'categories',
  'flag',
  'isRead',
  'conversationId',
  'parentFolderId',
  'hasAttachments',
  'internetMessageId',
  'internetMessageHeaders',
  'body',
].join(',');

const recipientSchema = z.object({
  emailAddress: z
    .object({ name: z.string().optional(), address: z.string().optional() })
    .optional(),
});

const folderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  parentFolderId: z.string().optional(),
  childFolderCount: z.number().optional(),
  totalItemCount: z.number().optional(),
});

const folderPageSchema = z.object({
  value: z.array(folderSchema),
  '@odata.nextLink': z.string().optional(),
});

const listedMessageSchema = z.object({
  id: z.string(),
  internetMessageId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedDateTime: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  '@removed': z.object({ reason: z.string().optional() }).optional(),
});

const messagePageSchema = z.object({
  value: z.array(listedMessageSchema),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

const attachmentSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  contentType: z.string().nullable().optional(),
  size: z.number().optional(),
  isInline: z.boolean().optional(),
  contentId: z.string().nullable().optional(),
});

const fullMessageSchema = z.object({
  id: z.string(),
  subject: z.string().nullable().optional(),
  from: recipientSchema.optional(),
  sender: recipientSchema.optional(),
  toRecipients: z.array(recipientSchema).optional(),
  ccRecipients: z.array(recipientSchema).optional(),
  bccRecipients: z.array(recipientSchema).optional(),
  replyTo: z.array(recipientSchema).optional(),
  sentDateTime: z.string().optional(),
  receivedDateTime: z.string().optional(),
  categories: z.array(z.string()).optional(),
  flag: z.record(z.string(), z.unknown()).optional(),
  isRead: z.boolean().optional(),
  conversationId: z.string().optional(),
  parentFolderId: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  internetMessageId: z.string().optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ contentType: z.string().optional() }).optional(),
  attachments: z.array(attachmentSchema).optional(),
});

function mapAddress(r: z.infer<typeof recipientSchema> | undefined): EmailAddressRef | undefined {
  if (r?.emailAddress === undefined) return undefined;
  return { name: r.emailAddress.name, address: r.emailAddress.address };
}

function mapAddressList(
  list: z.infer<typeof recipientSchema>[] | undefined,
): EmailAddressRef[] | undefined {
  if (list === undefined) return undefined;
  const mapped = list.map(mapAddress).filter((a): a is EmailAddressRef => a !== undefined);
  return mapped;
}

export class GraphEmailConnector implements EmailConnector {
  private readonly base: string;

  constructor(private readonly options: GraphConnectorOptions) {
    this.base = normalizeBaseUrl(options.graphBaseUrl);
  }

  private seg(custodian: string): string {
    return userSegment(this.options.mode, custodian);
  }

  private async get(url: string, headers?: Record<string, string>): Promise<Response> {
    return providerFetch(url, { method: 'GET', headers }, graphFetchOptions(this.options));
  }

  async listMailFolders(custodian: string): Promise<MailFolderDiscovery> {
    const folders: DiscoveredMailFolder[] = [];
    const exceptions: ConnectorException[] = [];
    const seg = this.seg(custodian);

    const walk = async (startUrl: string, parentPath: string, parentId?: string): Promise<void> => {
      let url: string | undefined = startUrl;
      while (url !== undefined) {
        const res = await ensureOk(await this.get(url), 'listMailFolders');
        const page = folderPageSchema.parse(await res.json());
        for (const f of page.value) {
          const path = `${parentPath}/${f.displayName}`;
          folders.push({
            id: f.id,
            displayName: f.displayName,
            parentId: parentId ?? f.parentFolderId,
            totalItemCount: f.totalItemCount,
            path,
          });
          if ((f.childFolderCount ?? 0) > 0) {
            await walk(
              `${this.base}${seg}/mailFolders/${encodeURIComponent(f.id)}/childFolders?$top=100`,
              path,
              f.id,
            );
          }
        }
        url = page['@odata.nextLink'];
      }
    };

    await walk(`${this.base}${seg}/mailFolders?includeHiddenFolders=true&$top=100`, '');

    // Recoverable items (deletions) is only reachable with sufficient rights;
    // a denial is recorded as an exception rather than failing discovery.
    const recoverableRes = await this.get(
      `${this.base}${seg}/mailFolders/recoverableitemsdeletions`,
    );
    if (recoverableRes.ok) {
      const f = folderSchema.parse(await recoverableRes.json());
      folders.push({
        id: f.id,
        displayName: f.displayName,
        wellKnown: 'recoverableitemsdeletions',
        totalItemCount: f.totalItemCount,
        path: `/${f.displayName}`,
      });
    } else if (recoverableRes.status === 403 || recoverableRes.status === 404) {
      exceptions.push({
        kind: recoverableRes.status === 403 ? 'permission_denied' : 'unavailable_item',
        message: `recoverable items deletions folder not accessible (HTTP ${recoverableRes.status})`,
      });
    } else {
      await ensureOk(recoverableRes, 'listMailFolders(recoverableitemsdeletions)');
    }

    return { folders, exceptions };
  }

  async listMessages(
    custodian: string,
    folderIdOrLabel: string,
    opts: ListMessagesOptions = {},
  ): Promise<EmailListPage> {
    let url: string;
    if (opts.cursor !== undefined) {
      url = opts.cursor;
    } else {
      const u = new URL(
        `${this.base}${this.seg(custodian)}/mailFolders/${encodeURIComponent(folderIdOrLabel)}/messages`,
      );
      u.searchParams.set('$select', MESSAGE_LIST_SELECT);
      u.searchParams.set('$top', '50');
      const filters: string[] = [];
      if (opts.since !== undefined) filters.push(`receivedDateTime ge ${opts.since}`);
      if (opts.until !== undefined) filters.push(`receivedDateTime le ${opts.until}`);
      if (filters.length > 0) u.searchParams.set('$filter', filters.join(' and '));
      url = u.toString();
    }
    const res = await ensureOk(
      await this.get(url, { Prefer: IMMUTABLE_ID_PREFER }),
      'listMessages',
    );
    const page = messagePageSchema.parse(await res.json());
    return {
      items: page.value.map((m) => this.mapListedMessage(m, folderIdOrLabel)),
      nextCursor: page['@odata.nextLink'],
    };
  }

  private mapListedMessage(
    m: z.infer<typeof listedMessageSchema>,
    folderId: string,
  ): EmailListEntry {
    return {
      providerItemId: m.id,
      // Prefer: IdType="ImmutableId" makes the returned id the immutable id.
      providerImmutableId: m.id,
      folderId,
      threadId: m.conversationId,
      receivedAt: m.receivedDateTime,
      hasAttachments: m.hasAttachments,
      deleted: m['@removed'] !== undefined ? true : undefined,
    };
  }

  async fetchMessage(custodian: string, providerItemId: string): Promise<FetchedEmail> {
    const seg = this.seg(custodian);
    const encoded = encodeURIComponent(providerItemId);
    const metaUrl =
      `${this.base}${seg}/messages/${encoded}` +
      `?$select=${MESSAGE_FULL_SELECT}` +
      `&$expand=attachments($select=id,name,contentType,size,isInline,contentId)`;
    const metaRes = await ensureOk(
      await this.get(metaUrl, { Prefer: IMMUTABLE_ID_PREFER }),
      'fetchMessage(metadata)',
    );
    const meta = fullMessageSchema.parse(await metaRes.json());

    const mimeRes = await ensureOk(
      await this.get(`${this.base}${seg}/messages/${encoded}/$value`, {
        Prefer: IMMUTABLE_ID_PREFER,
      }),
      'fetchMessage(mime)',
    );
    const rfc822 = new Uint8Array(await mimeRes.arrayBuffer());

    const metadata: EmailApiMetadata = {
      subject: meta.subject ?? undefined,
      from: mapAddress(meta.from),
      sender: mapAddress(meta.sender),
      toRecipients: mapAddressList(meta.toRecipients),
      ccRecipients: mapAddressList(meta.ccRecipients),
      replyTo: mapAddressList(meta.replyTo),
      sentAt: meta.sentDateTime,
      receivedAt: meta.receivedDateTime,
      categories: meta.categories,
      flags: meta.flag,
      isRead: meta.isRead,
      conversationId: meta.conversationId,
      folderId: meta.parentFolderId,
      internetMessageId: meta.internetMessageId,
      internetMessageHeaders: meta.internetMessageHeaders,
      bodyContentType: meta.body?.contentType,
      hasAttachments: meta.hasAttachments,
      attachments: meta.attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType ?? undefined,
        size: a.size,
        isInline: a.isInline,
        contentId: a.contentId ?? undefined,
      })),
    };
    // BCC is recorded ONLY when the API actually returned recipients.
    if (meta.bccRecipients !== undefined && meta.bccRecipients.length > 0) {
      metadata.bccRecipients = mapAddressList(meta.bccRecipients);
    }
    return { providerItemId: meta.id, rfc822, metadata };
  }

  async getMailDelta(
    custodian: string,
    folderId: string,
    deltaCursor?: string,
  ): Promise<EmailListPage> {
    const url =
      deltaCursor ??
      `${this.base}${this.seg(custodian)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$top=50`;
    const res = await this.get(url, { Prefer: IMMUTABLE_ID_PREFER });
    if (res.status === 410) {
      throw new DeltaExpiredError(
        `mail delta checkpoint for folder expired; a full re-enumeration is required`,
      );
    }
    await ensureOk(res, 'getMailDelta');
    const page = messagePageSchema.parse(await res.json());
    return {
      items: page.value.map((m) => this.mapListedMessage(m, folderId)),
      nextCursor: page['@odata.nextLink'],
      deltaCursor: page['@odata.deltaLink'],
    };
  }
}
