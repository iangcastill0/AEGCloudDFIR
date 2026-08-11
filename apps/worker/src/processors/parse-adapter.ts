/**
 * Thin adapter over email parsing. A parallel workstream is adding a full
 * MIME parser (parseEmail / buildSafeEmailPreview / htmlToText) to
 * @evidencevault/evidence; this adapter probes for it at runtime and falls
 * back to a MINIMAL header-only RFC822 parser when absent, marking results
 * with parserName 'minimal-parser' so downstream stays honest about fidelity.
 */

export interface ParsedAddress {
  name?: string;
  address?: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
  isInline?: boolean;
}

export interface ParsedEmail {
  subject: string;
  messageId: string;
  inReplyTo: string;
  references: string[];
  rawDateHeader: string;
  /** ISO date parsed from the Date header when parseable. */
  date?: string;
  /** Ordered raw headers with original casing. */
  headers: { name: string; value: string }[];
  from: ParsedAddress[];
  sender: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  replyTo: ParsedAddress[];
  bodyPlain: string;
  bodyHtml?: string;
  attachments: ParsedAttachment[];
  isEncrypted: boolean;
  smimeType: string;
  parserName: string;
  parserVersion: string;
}

export interface EmailParser {
  parse(rfc822: Uint8Array): Promise<ParsedEmail>;
  htmlToText(html: string): string;
  /** Present only when the full parser module provides safe preview building. */
  buildSafePreview?(html: string, resolveCid: (contentId: string) => string): string;
}

// ---------------------------------------------------------------------------
// Minimal fallback parser: headers block only, body as plain text.
// ---------------------------------------------------------------------------

function unfoldHeaderBlock(block: string): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  const lines = block.split(/\r\n|\n/);
  let current: { name: string; value: string } | null = null;
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (current !== null) current.value += ` ${line.trim()}`;
      continue;
    }
    if (current !== null) headers.push(current);
    current = null;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
  }
  if (current !== null) headers.push(current);
  return headers;
}

const ANGLE_ADDR_RE = /<([^<>]+)>/;
const BARE_ADDR_RE = /[^\s"<>,;]+@[^\s"<>,;]+/;

/** Naive but safe address-list splitting (commas outside quotes). */
export function parseAddressList(raw: string): ParsedAddress[] {
  const parts: string[] = [];
  let depth = false;
  let current = '';
  for (const ch of raw) {
    if (ch === '"') depth = !depth;
    if (ch === ',' && !depth) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const out: ParsedAddress[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const angle = ANGLE_ADDR_RE.exec(trimmed);
    if (angle !== null) {
      const name = trimmed.slice(0, angle.index).trim().replace(/^"|"$/g, '');
      out.push({ address: angle[1]?.trim(), ...(name !== '' ? { name } : {}) });
      continue;
    }
    const bare = BARE_ADDR_RE.exec(trimmed);
    if (bare !== null) {
      out.push({ address: bare[0] });
      continue;
    }
    out.push({ name: trimmed });
  }
  return out;
}

function headerValue(headers: { name: string; value: string }[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

export function parseRfc822Minimal(rfc822: Uint8Array): ParsedEmail {
  const text = Buffer.from(rfc822).toString('utf8');
  const splitAt = text.search(/\r\n\r\n|\n\n/);
  const headerBlock = splitAt === -1 ? text : text.slice(0, splitAt);
  const body = splitAt === -1 ? '' : text.slice(splitAt).replace(/^\r?\n\r?\n/, '');
  const headers = unfoldHeaderBlock(headerBlock);

  const rawDate = headerValue(headers, 'Date');
  const parsedDate = rawDate !== '' ? new Date(rawDate) : null;
  const contentType = headerValue(headers, 'Content-Type').toLowerCase();
  const isSmime = contentType.includes('pkcs7-mime') || contentType.includes('smime');

  return {
    subject: headerValue(headers, 'Subject'),
    messageId: headerValue(headers, 'Message-ID'),
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References')
      .split(/\s+/)
      .filter((r) => r !== ''),
    rawDateHeader: rawDate,
    date:
      parsedDate !== null && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : undefined,
    headers,
    from: parseAddressList(headerValue(headers, 'From')),
    sender: parseAddressList(headerValue(headers, 'Sender')),
    to: parseAddressList(headerValue(headers, 'To')),
    cc: parseAddressList(headerValue(headers, 'Cc')),
    bcc: parseAddressList(headerValue(headers, 'Bcc')),
    replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
    bodyPlain: body,
    attachments: [],
    isEncrypted: isSmime,
    smimeType: isSmime ? contentType.split(';')[0]?.trim() ?? '' : '',
    parserName: 'minimal-parser',
    parserVersion: '1',
  };
}

/** Fallback HTML→text: strips tags/entities; the full module replaces this. */
export function naiveHtmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const MINIMAL_PARSER: EmailParser = {
  parse: (rfc822) => Promise.resolve(parseRfc822Minimal(rfc822)),
  htmlToText: naiveHtmlToText,
};

interface FullParserModule {
  parseEmail: (rfc822: Uint8Array) => Promise<unknown>;
  htmlToText?: (html: string) => string;
  buildSafeEmailPreview?: (html: string, resolveCid: (contentId: string) => string) => string;
}

function hasFullParser(mod: Record<string, unknown>): mod is Record<string, unknown> & FullParserModule {
  return typeof mod['parseEmail'] === 'function';
}

function normalizeAddressList(value: unknown): ParsedAddress[] {
  if (!Array.isArray(value)) return [];
  const out: ParsedAddress[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const address = typeof record['address'] === 'string' ? record['address'] : undefined;
    const name = typeof record['name'] === 'string' ? record['name'] : undefined;
    if (address !== undefined || name !== undefined) out.push({ address, name });
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Defensive normalization of the (not-yet-frozen) full parser result shape. */
function normalizeFullResult(raw: unknown): ParsedEmail {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('full parser returned a non-object result');
  }
  const r = raw as Record<string, unknown>;
  const headers = Array.isArray(r['headers'])
    ? (r['headers'] as unknown[])
        .map((h) => {
          if (typeof h !== 'object' || h === null) return null;
          const hr = h as Record<string, unknown>;
          if (typeof hr['name'] !== 'string' || typeof hr['value'] !== 'string') return null;
          return { name: hr['name'], value: hr['value'] };
        })
        .filter((h): h is { name: string; value: string } => h !== null)
    : [];
  const attachments = Array.isArray(r['attachments'])
    ? (r['attachments'] as unknown[])
        .map((a): ParsedAttachment | null => {
          if (typeof a !== 'object' || a === null) return null;
          const ar = a as Record<string, unknown>;
          const content = ar['content'];
          if (!(content instanceof Uint8Array)) return null;
          return {
            filename: str(ar['filename']) !== '' ? str(ar['filename']) : 'attachment',
            contentType:
              str(ar['contentType']) !== '' ? str(ar['contentType']) : 'application/octet-stream',
            content,
            contentId: typeof ar['contentId'] === 'string' ? ar['contentId'] : undefined,
            isInline: ar['isInline'] === true,
          };
        })
        .filter((a): a is ParsedAttachment => a !== null)
    : [];
  return {
    subject: str(r['subject']),
    messageId: str(r['messageId']),
    inReplyTo: str(r['inReplyTo']),
    references: Array.isArray(r['references'])
      ? (r['references'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    rawDateHeader: str(r['rawDateHeader']),
    date: typeof r['date'] === 'string' ? r['date'] : undefined,
    headers,
    from: normalizeAddressList(r['from']),
    sender: normalizeAddressList(r['sender']),
    to: normalizeAddressList(r['to']),
    cc: normalizeAddressList(r['cc']),
    bcc: normalizeAddressList(r['bcc']),
    replyTo: normalizeAddressList(r['replyTo']),
    bodyPlain: str(r['bodyPlain']),
    bodyHtml: typeof r['bodyHtml'] === 'string' ? r['bodyHtml'] : undefined,
    attachments,
    isEncrypted: r['isEncrypted'] === true,
    smimeType: str(r['smimeType']),
    parserName: str(r['parserName']) !== '' ? str(r['parserName']) : 'evidence-parser',
    parserVersion: str(r['parserVersion']) !== '' ? str(r['parserVersion']) : '1',
  };
}

let cachedParser: Promise<EmailParser> | undefined;

/**
 * Load the best available email parser. The @evidencevault/evidence
 * processing module is probed dynamically — this package must not hard-depend
 * on it yet.
 */
export function loadEmailParser(): Promise<EmailParser> {
  cachedParser ??= (async () => {
    try {
      const mod = (await import('@evidencevault/evidence')) as unknown as Record<string, unknown>;
      if (hasFullParser(mod)) {
        const full = mod;
        const parser: EmailParser = {
          parse: async (rfc822) => normalizeFullResult(await full.parseEmail(rfc822)),
          htmlToText: (html) =>
            typeof full.htmlToText === 'function' ? full.htmlToText(html) : naiveHtmlToText(html),
        };
        if (typeof full.buildSafeEmailPreview === 'function') {
          const buildPreview = full.buildSafeEmailPreview;
          parser.buildSafePreview = (html, resolveCid) => buildPreview(html, resolveCid);
        }
        return parser;
      }
    } catch {
      // fall through to the minimal parser
    }
    return MINIMAL_PARSER;
  })();
  return cachedParser;
}

/** Test seam. */
export function resetParserCache(): void {
  cachedParser = undefined;
}
