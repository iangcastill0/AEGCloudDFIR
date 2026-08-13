import { randomUUID } from 'node:crypto';

/**
 * Pure RFC 5322/2045 message synthesis for PST-extracted messages.
 *
 * The output is an honest RECONSTRUCTION: when the PST retained the original
 * transport headers they are carried verbatim (minus MIME-structural headers,
 * which must describe the rebuilt body, not the lost original encoding);
 * otherwise minimal headers are synthesized from the container's stored
 * properties. Provenance lives in evidence metadata — nothing is ever
 * injected into the header block to make it look provider-native.
 */

export interface EmlAddress {
  name: string;
  address: string;
}

export interface EmlAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface BuildEmlInput {
  /** Verbatim transport headers from the source, when retained. */
  headersRaw?: string;
  from?: EmlAddress;
  to: EmlAddress[];
  cc: EmlAddress[];
  /** Included as a Bcc header ONLY when the PST property actually has it. */
  bcc: EmlAddress[];
  subject: string;
  date?: Date;
  messageId?: string;
  bodyPlain: string;
  bodyHtml: string;
  attachments: EmlAttachment[];
}

export interface BuildEmlOptions {
  /** Test seam: deterministic MIME boundaries. Must yield unique values. */
  boundaryFactory?: () => string;
}

const MAX_HEADER_LINE = 78;
const MAX_ENCODED_LINE = 76;

function isAscii(value: string): boolean {
  // Printable ASCII only; anything else needs an RFC 2047 encoded word.
  return /^[\x20-\x7e]*$/.test(value);
}

/** RFC 2047 encoded word (utf-8, base64). */
export function encodeWord(value: string): string {
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Fold one header onto continuation lines at spaces (RFC 5322 §2.2.3). */
export function foldHeader(name: string, value: string): string {
  const full = `${name}: ${value}`;
  if (full.length <= MAX_HEADER_LINE) return full;
  const words = value.split(' ');
  const lines: string[] = [];
  let current = `${name}:`;
  for (const word of words) {
    const candidate = `${current} ${word}`;
    if (candidate.length > MAX_HEADER_LINE && current !== `${name}:` && current !== ' ') {
      lines.push(current);
      current = ` ${word}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines.join('\r\n');
}

/** Quoted-printable encoding of UTF-8 text with soft breaks at 76 columns. */
export function encodeQuotedPrintable(text: string): string {
  const normalized = text.replace(/\r\n|\r|\n/g, '\r\n');
  const outLines: string[] = [];
  for (const line of normalized.split('\r\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let encoded = '';
    for (const byte of bytes) {
      const literal = (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9;
      encoded += literal
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    // Trailing whitespace must be encoded (it is not survivable in transport).
    encoded = encoded.replace(/ $/, '=20').replace(/\t$/, '=09');
    let rest = encoded;
    while (rest.length > MAX_ENCODED_LINE) {
      let cut = MAX_ENCODED_LINE - 1;
      // Never split an =XX escape across the soft break.
      if (rest[cut - 1] === '=') cut -= 1;
      else if (rest[cut - 2] === '=') cut -= 2;
      outLines.push(`${rest.slice(0, cut)}=`);
      rest = rest.slice(cut);
    }
    outLines.push(rest);
  }
  return outLines.join('\r\n');
}

/** Base64 body wrapped at 76 columns (RFC 2045 §6.8). */
export function wrapBase64(content: Buffer): string {
  const b64 = content.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += MAX_ENCODED_LINE) {
    lines.push(b64.slice(i, i + MAX_ENCODED_LINE));
  }
  return lines.join('\r\n');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** RFC 5322 date-time in UTC (the PST stores instants, not zone offsets). */
export function formatRfc5322Date(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

export function formatAddress(addr: EmlAddress): string {
  const name = addr.name.trim();
  if (name === '' || name === addr.address) return addr.address;
  let display: string;
  if (!isAscii(name)) display = encodeWord(name);
  else if (/[^A-Za-z0-9 .'-]/.test(name)) display = `"${name.replace(/(["\\])/g, '\\$1')}"`;
  else display = name;
  return addr.address === '' ? display : `${display} <${addr.address}>`;
}

/**
 * Keep the retained transport headers verbatim EXCEPT the MIME-structural
 * ones (Content-Type / Content-Transfer-Encoding / MIME-Version, with their
 * continuation lines): the original body encoding is not preserved in a PST,
 * so those headers must describe the reconstructed body instead.
 */
export function stripStructuralHeaders(raw: string): string {
  const normalized = raw.replace(/\r\n|\r|\n/g, '\r\n').replace(/(\r\n)+$/, '');
  const headerBlock = normalized.split('\r\n\r\n')[0] ?? '';
  const kept: string[] = [];
  let skipping = false;
  for (const line of headerBlock.split('\r\n')) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = /^(content-type|content-transfer-encoding|mime-version)\s*:/i.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join('\r\n');
}

interface MimeEntity {
  headers: string[];
  body: string;
}

function textEntity(subtype: 'plain' | 'html', text: string): MimeEntity {
  return {
    headers: [
      `Content-Type: text/${subtype}; charset=utf-8`,
      'Content-Transfer-Encoding: quoted-printable',
    ],
    body: encodeQuotedPrintable(text),
  };
}

function attachmentEntity(attachment: EmlAttachment): MimeEntity {
  const filename = isAscii(attachment.filename)
    ? attachment.filename.replace(/(["\\])/g, '\\$1')
    : encodeWord(attachment.filename);
  return {
    headers: [
      foldHeader('Content-Type', `${attachment.mimeType}; name="${filename}"`),
      'Content-Transfer-Encoding: base64',
      foldHeader('Content-Disposition', `attachment; filename="${filename}"`),
    ],
    body: wrapBase64(attachment.content),
  };
}

function multipartEntity(subtype: string, boundary: string, parts: MimeEntity[]): MimeEntity {
  const body =
    parts.map((p) => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}`).join('\r\n') +
    `\r\n--${boundary}--`;
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body,
  };
}

function synthesizeHeaders(input: BuildEmlInput): string[] {
  const headers: string[] = [];
  if (input.from !== undefined && (input.from.address !== '' || input.from.name !== '')) {
    headers.push(foldHeader('From', formatAddress(input.from)));
  }
  if (input.to.length > 0) {
    headers.push(foldHeader('To', input.to.map(formatAddress).join(', ')));
  }
  if (input.cc.length > 0) {
    headers.push(foldHeader('Cc', input.cc.map(formatAddress).join(', ')));
  }
  // Bcc appears ONLY when the PST property genuinely carried BCC recipients.
  if (input.bcc.length > 0) {
    headers.push(foldHeader('Bcc', input.bcc.map(formatAddress).join(', ')));
  }
  headers.push(
    foldHeader('Subject', isAscii(input.subject) ? input.subject : encodeWord(input.subject)),
  );
  if (input.date !== undefined) {
    headers.push(`Date: ${formatRfc5322Date(input.date)}`);
  }
  if (input.messageId !== undefined && input.messageId !== '') {
    headers.push(foldHeader('Message-ID', input.messageId));
  }
  return headers;
}

/**
 * Synthesize a .eml Buffer for one PST-extracted message. CRLF throughout;
 * multipart/alternative when both bodies exist; multipart/mixed when
 * attachments exist; unique boundaries per call.
 */
export function buildEml(input: BuildEmlInput, opts: BuildEmlOptions = {}): Buffer {
  const nextBoundary = opts.boundaryFactory ?? ((): string => `=_cdfir_${randomUUID()}`);

  const hasPlain = input.bodyPlain !== '';
  const hasHtml = input.bodyHtml !== '';
  let bodyEntity: MimeEntity;
  if (hasPlain && hasHtml) {
    bodyEntity = multipartEntity('alternative', nextBoundary(), [
      textEntity('plain', input.bodyPlain),
      textEntity('html', input.bodyHtml),
    ]);
  } else if (hasHtml) {
    bodyEntity = textEntity('html', input.bodyHtml);
  } else {
    bodyEntity = textEntity('plain', input.bodyPlain);
  }

  let entity: MimeEntity = bodyEntity;
  if (input.attachments.length > 0) {
    entity = multipartEntity('mixed', nextBoundary(), [
      bodyEntity,
      ...input.attachments.map(attachmentEntity),
    ]);
  }

  const topHeaders: string[] = [];
  if (input.headersRaw !== undefined && input.headersRaw.trim() !== '') {
    const kept = stripStructuralHeaders(input.headersRaw);
    if (kept !== '') topHeaders.push(kept);
  } else {
    topHeaders.push(...synthesizeHeaders(input));
  }
  topHeaders.push('MIME-Version: 1.0');

  const message = `${[...topHeaders, ...entity.headers].join('\r\n')}\r\n\r\n${entity.body}\r\n`;
  return Buffer.from(message, 'utf8');
}
