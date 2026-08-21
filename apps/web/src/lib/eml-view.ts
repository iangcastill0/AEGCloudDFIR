/**
 * Turn an evidence item into the header block of an email view.
 *
 * The stored preview file is the message BODY only — `process-parse.ts` saves
 * sanitized HTML or plain text and nothing else. So the From/To/Cc/Subject/Date
 * lines a reviewer expects above a message have to be rebuilt here, from the
 * parsed participants the API returns and, failing that, the raw headers.
 *
 * Pure on purpose: every rule about what a reviewer is shown is testable without
 * a browser.
 */
import { formatDateTime } from './format';

export interface EmlParticipant {
  role: string;
  name: string;
  address: string;
}

export interface EmlSource {
  kind: string;
  name: string;
  primaryDate: string | null;
  emailMetadata: Record<string, unknown> | null;
  participants: EmlParticipant[];
  headers: { name: string; value: string }[];
}

export interface EmlRow {
  label: string;
  value: string;
}

/** `Name <address>`, comma separated, address alone when there is no name. */
export function formatAddressList(participants: EmlParticipant[], role: string): string {
  return participants
    .filter((p) => p.role === role && p.address.trim() !== '')
    .map((p) =>
      p.name.trim() === '' ? p.address.trim() : `${p.name.trim()} <${p.address.trim()}>`,
    )
    .join(', ');
}

function rawHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name)?.value.trim() ?? '';
}

function metaString(meta: Record<string, unknown> | null, key: string): string {
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** True when this item should be shown as a message rather than a file. */
export function isEmailLike(item: EmlSource): boolean {
  return item.kind === 'email' || item.emailMetadata !== null;
}

/**
 * The header rows to show, in the order an email client shows them.
 *
 * bcc is never a row. The API already filters bcc out; this filters again,
 * because a recovered bcc address is not a delivered header and must not be
 * presented beside From and To as though it were one. `bccPresent` is surfaced
 * separately, as a sentence.
 */
export function emlHeaderRows(item: EmlSource): EmlRow[] {
  const people = item.participants.filter((p) => p.role !== 'bcc');
  const headers = item.headers.filter((h) => h.name.toLowerCase() !== 'bcc');

  // Parsed participants win. They come from the message's own headers at parse
  // time; the raw list is the fallback for mail that arrived without raw MIME.
  const addresses = (role: string, headerName: string): string =>
    formatAddressList(people, role) || rawHeader(headers, headerName);

  const subject =
    metaString(item.emailMetadata, 'subject') || rawHeader(headers, 'subject') || item.name;
  const sentAt = metaString(item.emailMetadata, 'sentAt');
  const receivedAt = metaString(item.emailMetadata, 'receivedAt');
  const date = sentAt || receivedAt || item.primaryDate;

  const rows: EmlRow[] = [
    { label: 'From', value: addresses('from', 'from') || addresses('sender', 'sender') },
    { label: 'To', value: addresses('to', 'to') },
    { label: 'Cc', value: addresses('cc', 'cc') },
    { label: 'Reply-To', value: addresses('reply_to', 'reply-to') },
    { label: 'Subject', value: subject },
    { label: 'Date', value: date === null || date === '' ? '' : formatDateTime(date) },
  ];

  // An empty row is worse than a missing one: it reads as "nobody was on this
  // message" rather than "this was not recorded".
  return rows.filter((row) => row.value !== '');
}

/**
 * Facts about where the message was found, not headers of the message.
 *
 * Kept out of the header rows on purpose: a mailbox folder is something we
 * observed, not a line the sender wrote. Mixing the two would make the view
 * claim more than the message does.
 */
export function emlContextRows(item: EmlSource): EmlRow[] {
  const rows: EmlRow[] = [
    { label: 'Folder', value: metaString(item.emailMetadata, 'folder') },
    { label: 'Message-ID', value: metaString(item.emailMetadata, 'messageId') },
  ];
  return rows.filter((row) => row.value !== '');
}

/** True when the message had a bcc that the stored copy does not name. */
export function hadHiddenBcc(item: EmlSource): boolean {
  return item.emailMetadata?.['bccPresent'] === true;
}
