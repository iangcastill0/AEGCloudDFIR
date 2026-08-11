import { describe, expect, it } from 'vitest';
import { naiveHtmlToText, parseAddressList, parseRfc822Minimal } from './parse-adapter.js';

const CRLF = '\r\n';

function rawEmail(lines: string[], body: string): Uint8Array {
  return Buffer.from(lines.join(CRLF) + CRLF + CRLF + body, 'utf8');
}

describe('parseRfc822Minimal', () => {
  it('extracts headers, participants, and body from a raw message', () => {
    const parsed = parseRfc822Minimal(
      rawEmail(
        [
          'From: Alice Example <alice@example.com>',
          'To: "Bob, Jr." <bob@example.org>, carol@example.net',
          'Subject: Quarterly numbers',
          'Date: Tue, 10 Mar 2026 12:00:00 +0000',
          'Message-ID: <msg-1@example.com>',
          'X-Custom: keep',
          '\tfolded value',
        ],
        'Hello world.',
      ),
    );
    expect(parsed.subject).toBe('Quarterly numbers');
    expect(parsed.messageId).toBe('<msg-1@example.com>');
    expect(parsed.from).toEqual([{ name: 'Alice Example', address: 'alice@example.com' }]);
    expect(parsed.to).toEqual([
      { name: 'Bob, Jr.', address: 'bob@example.org' },
      { address: 'carol@example.net' },
    ]);
    expect(parsed.bodyPlain).toBe('Hello world.');
    expect(parsed.headers.find((h) => h.name === 'X-Custom')?.value).toBe('keep folded value');
    expect(parsed.parserName).toBe('minimal-parser');
    expect(parsed.date).toBe('2026-03-10T12:00:00.000Z');
  });

  it('reports bcc participants ONLY when a Bcc header is actually present', () => {
    const withoutBcc = parseRfc822Minimal(
      rawEmail(['From: a@x.com', 'To: b@x.com', 'Subject: s'], 'body'),
    );
    expect(withoutBcc.bcc).toEqual([]);

    const withBcc = parseRfc822Minimal(
      rawEmail(['From: a@x.com', 'To: b@x.com', 'Bcc: hidden@x.com', 'Subject: s'], 'body'),
    );
    expect(withBcc.bcc).toEqual([{ address: 'hidden@x.com' }]);
  });

  it('flags smime content types as encrypted', () => {
    const parsed = parseRfc822Minimal(
      rawEmail(
        ['From: a@x.com', 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data'],
        '',
      ),
    );
    expect(parsed.isEncrypted).toBe(true);
    expect(parsed.smimeType).toBe('application/pkcs7-mime');
  });
});

describe('parseAddressList', () => {
  it('splits on commas outside quotes and parses angle addresses', () => {
    expect(parseAddressList('"Smith, John" <j@x.com>, plain@y.org')).toEqual([
      { name: 'Smith, John', address: 'j@x.com' },
      { address: 'plain@y.org' },
    ]);
  });
});

describe('naiveHtmlToText', () => {
  it('strips tags and preserves basic line structure', () => {
    expect(naiveHtmlToText('<p>Hello <b>world</b></p><p>bye</p>')).toBe('Hello world\nbye');
  });
});
