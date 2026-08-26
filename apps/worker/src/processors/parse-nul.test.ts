import { describe, expect, it } from 'vitest';
import { loadEmailParser } from './parse-adapter';
import { pgText, pgTextList } from '../pg-text';

/**
 * A real message, through the real parser the processor uses, carrying the byte
 * that broke a live collection.
 *
 * Two messages in a 29,000 message Gmail collection contained a NUL, and
 * `emailMetadata.upsert` died on `invalid byte sequence for encoding "UTF8":
 * 0x00`. Those items stayed preserved and were never parsed. A mocked parser
 * would have passed this happily, which is why the bytes are built here.
 */
const NUL = String.fromCharCode(0);

function messageWithNul(): Buffer {
  return Buffer.from(
    [
      'From: Alice Smith <alice@example.com>',
      'To: bob@example.com',
      `Subject: Q3 numbers${NUL} final`,
      'Message-ID: <abc@example.com>',
      `X-Odd-Header: value${NUL}here`,
      'Date: Wed, 4 Mar 2026 05:06:07 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Body text with a NUL${NUL} inside it.`,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe('parsing a message that contains a NUL byte', () => {
  it('the parser really does hand us the NUL — this is not hypothetical', async () => {
    const parser = await loadEmailParser();
    const parsed = await parser.parse(messageWithNul());
    const sawNul =
      parsed.subject.includes(NUL) ||
      parsed.bodyPlain.includes(NUL) ||
      parsed.headers.some((h) => h.value.includes(NUL));
    expect(sawNul).toBe(true);
  });

  it('every field bound for a text column is clean after pgText', async () => {
    const parser = await loadEmailParser();
    const parsed = await parser.parse(messageWithNul());

    // Exactly the fields process-parse writes to Postgres.
    const written = [
      pgText(parsed.subject),
      pgText(parsed.messageId),
      pgText(parsed.inReplyTo),
      pgText(parsed.rawDateHeader),
      pgText(parsed.bodyPlain),
      pgText(parsed.smimeType),
      ...pgTextList(parsed.references),
      ...parsed.headers.flatMap((h) => [pgText(h.name), pgText(h.value)]),
      ...[
        ...parsed.from,
        ...parsed.sender,
        ...parsed.to,
        ...parsed.cc,
        ...parsed.bcc,
        ...parsed.replyTo,
      ].flatMap((a) => [pgText(a.name ?? ''), pgText(a.address ?? '')]),
    ];

    for (const value of written) {
      expect(value.includes(NUL)).toBe(false);
    }
  });

  it('keeps the readable text around the NUL, rather than dropping the field', async () => {
    const parser = await loadEmailParser();
    const parsed = await parser.parse(messageWithNul());
    // The subject stays usable; only the unstorable byte is gone.
    expect(pgText(parsed.subject)).toBe('Q3 numbers final');
    expect(pgText(parsed.bodyPlain)).toContain('Body text with a NUL inside it.');
  });
});
