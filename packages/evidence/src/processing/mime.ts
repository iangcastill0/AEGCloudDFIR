/**
 * RFC 822/2045 email parsing for the evidence pipeline.
 *
 * Wraps mailparser's simpleParser and produces a `ParsedEmail` that keeps
 * BOTH the raw headers (original order and casing, for evidentiary fidelity)
 * and normalized searchable fields (lowercased addresses, decoded subject).
 *
 * Guarantees:
 * - never throws on malformed input: degrades to best-effort output and sets
 *   `headersMalformed`,
 * - `bccPresent` is true only when a Bcc header actually exists in the raw
 *   source (checked against headerLines, never inferred),
 * - attachments keep their original bytes (no extra copies beyond
 *   mailparser's buffer); `message/rfc822` attachments carry the nested raw
 *   message so callers can recursively parse an evidence family,
 * - S/MIME / PGP encrypted or signed structures are detected, never decrypted.
 */

import {
  simpleParser,
  type AddressObject,
  type EmailAddress,
  type HeaderValue,
  type ParsedMail,
  type StructuredHeader,
} from 'mailparser';
import { sanitizeFilename } from '../objectKeys.js';
import { htmlToText } from './html-to-text.js';

export type ParticipantRole = 'from' | 'sender' | 'to' | 'cc' | 'bcc' | 'reply_to';

export interface RawHeader {
  /** Lowercased header name ('message-id'). */
  name: string;
  /** Header name exactly as it appeared in the source ('Message-ID'). */
  rawName: string;
  /** Decoded header value: unfolded, RFC 2047 encoded-words decoded. */
  value: string;
  /** Zero-based position of the header line in the original message. */
  position: number;
}

export interface EmailParticipant {
  role: ParticipantRole;
  /** Display name as decoded by the parser (may be ''). */
  rawName: string;
  /** Address exactly as parsed (original casing). */
  rawAddress: string;
  /** Lowercased, trimmed address for search/dedup. */
  normalizedAddress: string;
  /** Domain part of the normalized address ('' if unparsable). */
  domain: string;
  /** Zero-based position within the header for this role. */
  position: number;
}

export interface ParsedAttachment {
  /** Sanitized filename; falls back to 'attachment-N.bin'. */
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId?: string;
  /** Disposition inline OR referenced from the HTML body via cid:. */
  isInline: boolean;
  /** message/rfc822: `content` is the nested raw message (parse recursively). */
  isNestedMessage: boolean;
}

export type SmimeType =
  | ''
  | 'application/pkcs7-mime'
  | 'multipart/encrypted'
  | 'multipart/signed';

export interface ParsedEmail {
  rawHeaders: RawHeader[];
  subject: string;
  messageId: string;
  inReplyTo: string;
  references: string[];
  date?: Date;
  /** Original Date: header text, offset preserved ('... +0530'). */
  rawDateHeader: string;
  participants: EmailParticipant[];
  /** TRUE only when a Bcc header exists in the raw source. */
  bccPresent: boolean;
  bodyPlain: string;
  bodyHtml: string | null;
  attachments: ParsedAttachment[];
  isEncrypted: boolean;
  smimeType: SmimeType;
  /** Parser saw malformed headers but produced best-effort output. */
  headersMalformed: boolean;
}

// RFC 5322 header field name: printable US-ASCII except ':' (and no spaces).
const HEADER_NAME_RE = /^([!-9;-~]+):/;

/**
 * Decode RFC 2047 encoded-words (=?charset?B|Q?data?=). mailparser already
 * decodes structured fields (subject, names); this is used for the preserved
 * raw header values so they are searchable too.
 */
export function decodeEncodedWords(input: string): string {
  // Whitespace between adjacent encoded words is ignored per RFC 2047 §6.2.
  const joined = input.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)[ \t]+(?==\?)/g, '$1');
  return joined.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g,
    (whole, charsetRaw: string, encoding: string, data: string) => {
      // Strip RFC 2231 language suffix ('utf-8*en').
      const charset = charsetRaw.split('*')[0] ?? 'utf-8';
      let bytes: Buffer;
      if (encoding.toLowerCase() === 'b') {
        bytes = Buffer.from(data, 'base64');
      } else {
        const qText = data.replace(/_/g, ' ');
        const byteValues: number[] = [];
        for (let i = 0; i < qText.length; i += 1) {
          if (qText[i] === '=' && i + 2 < qText.length + 1) {
            const hex = qText.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              byteValues.push(Number.parseInt(hex, 16));
              i += 2;
              continue;
            }
          }
          byteValues.push(qText.charCodeAt(i));
        }
        bytes = Buffer.from(byteValues);
      }
      try {
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch {
        try {
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch {
          return whole;
        }
      }
    },
  );
}

function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}

function buildRawHeaders(headerLines: ParsedMail['headerLines']): {
  rawHeaders: RawHeader[];
  malformed: boolean;
} {
  const rawHeaders: RawHeader[] = [];
  let malformed = false;
  headerLines.forEach((entry, position) => {
    const line = entry.line;
    const match = HEADER_NAME_RE.exec(line);
    if (!match || match[1] === undefined) {
      // Garbage line without a valid 'Name:' prefix — keep it (evidentiary
      // fidelity) but flag the message.
      malformed = true;
      rawHeaders.push({
        name: entry.key.toLowerCase(),
        rawName: unfold(line),
        value: '',
        position,
      });
      return;
    }
    const rawName = match[1];
    rawHeaders.push({
      name: rawName.toLowerCase(),
      rawName,
      value: decodeEncodedWords(unfold(line.slice(rawName.length + 1))),
      position,
    });
  });
  return { rawHeaders, malformed };
}

function flattenAddresses(value: EmailAddress[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const entry of value) {
    if (entry.group !== undefined) {
      out.push(...flattenAddresses(entry.group));
    } else {
      out.push(entry);
    }
  }
  return out;
}

function addressObjects(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return flattenAddresses(list.flatMap((obj) => obj.value));
}

function toParticipants(role: ParticipantRole, addresses: EmailAddress[]): EmailParticipant[] {
  return addresses.map((addr, position) => {
    const rawAddress = addr.address ?? '';
    const normalizedAddress = rawAddress.trim().toLowerCase();
    const at = normalizedAddress.lastIndexOf('@');
    return {
      role,
      rawName: addr.name ?? '',
      rawAddress,
      normalizedAddress,
      domain: at > 0 ? normalizedAddress.slice(at + 1) : '',
      position,
    };
  });
}

function isAddressObject(value: HeaderValue | undefined): value is AddressObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    'value' in value &&
    Array.isArray((value as AddressObject).value)
  );
}

function detectSmime(parsed: ParsedMail): { isEncrypted: boolean; smimeType: SmimeType } {
  const contentType = parsed.headers.get('content-type') as StructuredHeader | undefined;
  const topType = (contentType?.value ?? '').toLowerCase();
  if (topType === 'multipart/encrypted') {
    return { isEncrypted: true, smimeType: 'multipart/encrypted' };
  }
  if (topType === 'application/pkcs7-mime' || topType === 'application/x-pkcs7-mime') {
    return { isEncrypted: true, smimeType: 'application/pkcs7-mime' };
  }
  if (topType === 'multipart/signed') {
    return { isEncrypted: false, smimeType: 'multipart/signed' };
  }
  // An smime.p7m attachment wraps the whole message even when the outer
  // content type is generic.
  const p7m = parsed.attachments.some((att) => {
    const type = att.contentType.toLowerCase();
    return type === 'application/pkcs7-mime' || type === 'application/x-pkcs7-mime';
  });
  if (p7m) {
    return { isEncrypted: true, smimeType: 'application/pkcs7-mime' };
  }
  return { isEncrypted: false, smimeType: '' };
}

function buildAttachments(parsed: ParsedMail, bodyHtml: string | null): ParsedAttachment[] {
  return parsed.attachments.map((att, index) => {
    const cid = att.cid ?? '';
    const referencedInHtml =
      cid !== '' && bodyHtml !== null && bodyHtml.includes(`cid:${cid}`);
    const fallback = `attachment-${index + 1}.bin`;
    let filename = fallback;
    if (typeof att.filename === 'string' && att.filename.trim() !== '') {
      const sanitized = sanitizeFilename(att.filename);
      filename = sanitized === 'file' ? fallback : sanitized;
    }
    const contentType = att.contentType.toLowerCase();
    const attachment: ParsedAttachment = {
      filename,
      contentType,
      size: att.size,
      content: att.content,
      isInline:
        att.contentDisposition === 'inline' || att.related === true || referencedInHtml,
      isNestedMessage: contentType === 'message/rfc822',
    };
    if (cid !== '') attachment.contentId = cid;
    return attachment;
  });
}

function degradedResult(reason: string): ParsedEmail {
  // simpleParser almost never throws; when it does, record a fully-degraded
  // but well-formed result so the pipeline can record a processing exception
  // instead of crashing.
  console.error(`parseEmail: parser failure, producing degraded output: ${reason}`);
  return {
    rawHeaders: [],
    subject: '',
    messageId: '',
    inReplyTo: '',
    references: [],
    rawDateHeader: '',
    participants: [],
    bccPresent: false,
    bodyPlain: '',
    bodyHtml: null,
    attachments: [],
    isEncrypted: false,
    smimeType: '',
    headersMalformed: true,
  };
}

/**
 * Parse a raw RFC 822 message into normalized fields plus preserved raw
 * headers. Never rejects on malformed content — degrades and flags instead.
 */
export async function parseEmail(rfc822: Buffer): Promise<ParsedEmail> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(rfc822, {
      // Keep cid: links intact instead of inlining data: URIs so previews can
      // resolve them to same-origin derivatives (and never embed megabytes of
      // base64 into the index).
      keepCidLinks: true,
    });
  } catch (err) {
    return degradedResult(err instanceof Error ? err.message : String(err));
  }

  const { rawHeaders, malformed } = buildRawHeaders(parsed.headerLines);

  const bccPresent = parsed.headerLines.some((entry) => entry.key.toLowerCase() === 'bcc');

  const participants: EmailParticipant[] = [
    ...toParticipants('from', addressObjects(parsed.from)),
    ...toParticipants(
      'sender',
      isAddressObject(parsed.headers.get('sender'))
        ? addressObjects(parsed.headers.get('sender') as AddressObject)
        : [],
    ),
    ...toParticipants('to', addressObjects(parsed.to)),
    ...toParticipants('cc', addressObjects(parsed.cc)),
    ...toParticipants('bcc', bccPresent ? addressObjects(parsed.bcc) : []),
    ...toParticipants('reply_to', addressObjects(parsed.replyTo)),
  ];

  // The typings say `string | false` but mailparser can also leave it
  // undefined when there is no html part.
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : null;
  const bodyPlain =
    parsed.text !== undefined && parsed.text !== ''
      ? parsed.text
      : bodyHtml !== null
        ? htmlToText(bodyHtml)
        : '';

  const references =
    parsed.references === undefined
      ? []
      : Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references];

  const rawDateHeader = rawHeaders.find((h) => h.name === 'date')?.value ?? '';

  const { isEncrypted, smimeType } = detectSmime(parsed);

  const result: ParsedEmail = {
    rawHeaders,
    subject: parsed.subject ?? '',
    messageId: parsed.messageId ?? '',
    inReplyTo: parsed.inReplyTo ?? '',
    references,
    rawDateHeader,
    participants,
    bccPresent,
    bodyPlain,
    bodyHtml,
    attachments: buildAttachments(parsed, bodyHtml),
    isEncrypted,
    smimeType,
    headersMalformed: malformed,
  };
  if (parsed.date !== undefined) result.date = parsed.date;
  return result;
}
