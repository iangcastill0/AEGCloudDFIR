import { describe, expect, it } from 'vitest';
import {
  buildEml,
  encodeQuotedPrintable,
  encodeWord,
  foldHeader,
  formatAddress,
  formatRfc5322Date,
  stripStructuralHeaders,
  wrapBase64,
  type BuildEmlInput,
} from './pst-mime.js';

function boundarySeq(...names: string[]): () => string {
  const queue = [...names];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('boundary factory exhausted');
    return next;
  };
}

function baseInput(overrides: Partial<BuildEmlInput> = {}): BuildEmlInput {
  return {
    from: { name: 'Avery Chen', address: 'avery.chen@example.com' },
    to: [{ name: 'Jordan Lee', address: 'jordan.lee@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Quarterly report',
    date: new Date('2026-02-01T10:30:00Z'),
    messageId: '<msg-1@example.com>',
    bodyPlain: 'Hello Jordan,\nSee attached.\n',
    bodyHtml: '',
    attachments: [],
    ...overrides,
  };
}

describe('encodeQuotedPrintable', () => {
  it('passes printable ASCII through and encodes UTF-8 bytes', () => {
    expect(encodeQuotedPrintable('plain text')).toBe('plain text');
    expect(encodeQuotedPrintable('café')).toBe('caf=C3=A9');
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db');
  });

  it('encodes trailing whitespace and preserves CRLF line structure', () => {
    expect(encodeQuotedPrintable('line one \nline two\t')).toBe('line one=20\r\nline two=09');
  });

  it('soft-wraps so no line exceeds 76 characters and never splits an escape', () => {
    const encoded = encodeQuotedPrintable(`${'x'.repeat(70)}é${'y'.repeat(30)}`);
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
      // A soft break must not split an =XX escape (no dangling '=C' etc.).
      expect(line).not.toMatch(/=[0-9A-F]$/);
    }
    // Round-trippable: strip soft breaks, decode escapes.
    const decoded = encoded
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    expect(Buffer.from(decoded, 'latin1').toString('utf8')).toBe(
      `${'x'.repeat(70)}é${'y'.repeat(30)}`,
    );
  });
});

describe('wrapBase64', () => {
  it('wraps at exactly 76 columns', () => {
    const wrapped = wrapBase64(Buffer.alloc(200, 7));
    const lines = wrapped.split('\r\n');
    for (const line of lines.slice(0, -1)) expect(line.length).toBe(76);
    expect(lines[lines.length - 1]!.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(wrapped.replace(/\r\n/g, ''), 'base64')).toEqual(Buffer.alloc(200, 7));
  });
});

describe('foldHeader', () => {
  it('leaves short headers on one line', () => {
    expect(foldHeader('Subject', 'hi')).toBe('Subject: hi');
  });

  it('folds long headers at spaces with continuation whitespace', () => {
    const value = Array.from({ length: 12 }, (_, i) => `recipient${i}@example.com,`).join(' ');
    const folded = foldHeader('To', value);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    for (const cont of lines.slice(1)) expect(cont.startsWith(' ')).toBe(true);
    expect(lines.join('').replace(/\s+/g, ' ')).toContain('recipient11@example.com');
  });
});

describe('formatRfc5322Date / formatAddress / encodeWord', () => {
  it('formats an RFC 5322 UTC date', () => {
    expect(formatRfc5322Date(new Date('2026-02-01T10:30:05Z'))).toBe(
      'Sun, 01 Feb 2026 10:30:05 +0000',
    );
  });

  it('quotes and encodes display names as needed', () => {
    expect(formatAddress({ name: '', address: 'a@x.com' })).toBe('a@x.com');
    expect(formatAddress({ name: 'Jane Doe', address: 'j@x.com' })).toBe('Jane Doe <j@x.com>');
    expect(formatAddress({ name: 'Doe, Jane', address: 'j@x.com' })).toBe('"Doe, Jane" <j@x.com>');
    expect(formatAddress({ name: 'Zoë', address: 'z@x.com' })).toBe(
      `${encodeWord('Zoë')} <z@x.com>`,
    );
    expect(formatAddress({ name: 'Name Only', address: '' })).toBe('Name Only');
  });
});

describe('stripStructuralHeaders', () => {
  it('removes MIME-structural headers including continuation lines', () => {
    const raw = [
      'From: a@x.com',
      'Content-Type: multipart/mixed;',
      ' boundary="original-boundary"',
      'MIME-Version: 1.0',
      'Content-Transfer-Encoding: 7bit',
      'Subject: kept',
    ].join('\r\n');
    const kept = stripStructuralHeaders(raw);
    expect(kept).toBe('From: a@x.com\r\nSubject: kept');
  });

  it('normalizes bare-LF input and drops any accidental body text', () => {
    const kept = stripStructuralHeaders('From: a@x.com\nX-Custom: 1\n\nbody line');
    expect(kept).toBe('From: a@x.com\r\nX-Custom: 1');
  });
});

describe('buildEml', () => {
  it('uses CRLF exclusively', () => {
    const eml = buildEml(baseInput()).toString('utf8');
    expect(eml).not.toMatch(/[^\r]\n/);
    expect(eml.startsWith('From: ')).toBe(true);
  });

  it('synthesizes minimal headers from PST properties when transport headers are absent', () => {
    const eml = buildEml(baseInput()).toString('utf8');
    expect(eml).toContain('From: Avery Chen <avery.chen@example.com>');
    expect(eml).toContain('To: Jordan Lee <jordan.lee@example.com>');
    expect(eml).toContain('Subject: Quarterly report');
    expect(eml).toContain('Date: Sun, 01 Feb 2026 10:30:00 +0000');
    expect(eml).toContain('Message-ID: <msg-1@example.com>');
    expect(eml).toContain('MIME-Version: 1.0');
    // Provenance never gets injected into the header block.
    expect(eml).not.toMatch(/X-CDFIR/i);
  });

  it('carries retained transport headers verbatim minus structural headers', () => {
    const eml = buildEml(
      baseInput({
        headersRaw:
          'Received: from mail.example.com\r\nFrom: original@example.com\r\nContent-Type: text/enriched\r\nSubject: original subject\r\n',
      }),
    ).toString('utf8');
    expect(eml).toContain('Received: from mail.example.com');
    expect(eml).toContain('From: original@example.com');
    expect(eml).toContain('Subject: original subject');
    // Structural headers now describe the reconstructed body, not the original.
    expect(eml).not.toContain('text/enriched');
    // No synthesized duplicates alongside the retained headers.
    expect(eml).not.toContain('From: Avery Chen');
    expect(eml).not.toContain('Subject: Quarterly report');
  });

  it('includes a Bcc header ONLY when the PST property has BCC recipients', () => {
    const without = buildEml(baseInput()).toString('utf8');
    expect(without).not.toMatch(/^Bcc:/m);
    const withBcc = buildEml(
      baseInput({ bcc: [{ name: '', address: 'hidden@example.com' }] }),
    ).toString('utf8');
    expect(withBcc).toContain('Bcc: hidden@example.com');
  });

  it('builds multipart/alternative when both plain and HTML bodies exist', () => {
    const eml = buildEml(baseInput({ bodyPlain: 'plain body', bodyHtml: '<p>html body</p>' }), {
      boundaryFactory: boundarySeq('ALT'),
    }).toString('utf8');
    expect(eml).toContain('Content-Type: multipart/alternative; boundary="ALT"');
    expect(eml).toContain('Content-Type: text/plain; charset=utf-8');
    expect(eml).toContain('Content-Type: text/html; charset=utf-8');
    expect(eml.indexOf('text/plain')).toBeLessThan(eml.indexOf('text/html'));
    expect(eml).toContain('--ALT--');
  });

  it('quoted-printable-encodes UTF-8 bodies', () => {
    const eml = buildEml(baseInput({ bodyPlain: 'naïve résumé' })).toString('utf8');
    expect(eml).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(eml).toContain('na=C3=AFve r=C3=A9sum=C3=A9');
  });

  it('wraps attachments in multipart/mixed with base64 at 76 columns', () => {
    const content = Buffer.alloc(120, 3);
    const eml = buildEml(
      baseInput({
        bodyPlain: 'see attachment',
        bodyHtml: '<p>see attachment</p>',
        attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', content }],
      }),
      { boundaryFactory: boundarySeq('ALT', 'MIXED') },
    ).toString('utf8');
    expect(eml).toContain('Content-Type: multipart/mixed; boundary="MIXED"');
    expect(eml).toContain('Content-Type: multipart/alternative; boundary="ALT"');
    expect(eml).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(eml).toContain('Content-Transfer-Encoding: base64');
    const b64Block = eml
      .split('Content-Disposition: attachment; filename="report.pdf"\r\n\r\n')[1]!
      .split('\r\n--')[0]!;
    const lines = b64Block.split('\r\n');
    for (const line of lines.slice(0, -1)) expect(line.length).toBe(76);
    expect(Buffer.from(b64Block.replace(/\r\n/g, ''), 'base64')).toEqual(content);
  });

  it('uses distinct boundaries for nested multiparts by default', () => {
    const eml = buildEml(
      baseInput({
        bodyPlain: 'p',
        bodyHtml: '<p>h</p>',
        attachments: [
          { filename: 'a.bin', mimeType: 'application/octet-stream', content: Buffer.from('x') },
        ],
      }),
    ).toString('utf8');
    const boundaries = [...eml.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]);
    expect(boundaries).toHaveLength(2);
    expect(new Set(boundaries).size).toBe(2);
  });

  it('encodes non-ASCII subjects as RFC 2047 words', () => {
    const eml = buildEml(baseInput({ subject: 'Prüfung' })).toString('utf8');
    expect(eml).toContain(`Subject: ${encodeWord('Prüfung')}`);
  });
});
