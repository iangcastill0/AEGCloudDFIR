import { describe, expect, it } from 'vitest';
import { createImapConnectorRequest } from '@aeg-clouddfir/contracts';
import { buildImapConnector, defaultImapLabel, imapPresetById } from './imap-setup';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function base(over: Record<string, unknown> = {}) {
  return {
    presetId: 'yahoo',
    label: '',
    username: '  someone@yahoo.com  ',
    appPassword: 'abcd efgh ijkl mnop',
    host: '',
    port: '993',
    now: NOW,
    ...over,
  } as Parameters<typeof buildImapConnector>[0];
}

describe('buildImapConnector', () => {
  it('fills the server details from the chosen provider', () => {
    // Nobody remembers IMAP hostnames, and a typo produces a connection error
    // that reads like a wrong password.
    const body = buildImapConnector(base());
    expect(body.host).toBe('imap.mail.yahoo.com');
    expect(body.port).toBe(993);
    expect(body.secure).toBe(true);
    expect(body.username).toBe('someone@yahoo.com');
  });

  it('produces a body the API schema accepts', () => {
    expect(createImapConnectorRequest.safeParse(buildImapConnector(base())).success).toBe(true);
  });

  it('accepts a custom server', () => {
    const body = buildImapConnector(
      base({ presetId: 'custom', host: ' mail.example.com ', port: ' 993 ' }),
    );
    expect(body.host).toBe('mail.example.com');
    expect(body.port).toBe(993);
    expect(body.secure).toBe(true);
  });

  it('treats port 143 as STARTTLS rather than implicit TLS', () => {
    // The one place a port number changes the security of the connection.
    // Claiming implicit TLS on 143 would fail to connect at all.
    const body = buildImapConnector(
      base({ presetId: 'custom', host: 'mail.example.com', port: '143' }),
    );
    expect(body.secure).toBe(false);
  });

  it('labels the connection with the mailbox and the date when none is given', () => {
    expect(buildImapConnector(base()).label).toBe('someone@yahoo.com (IMAP) 2026-08-26');
    expect(defaultImapLabel('a@b.com', NOW)).toBe('a@b.com (IMAP) 2026-08-26');
  });

  it('keeps a label the operator typed', () => {
    expect(buildImapConnector(base({ label: '  Custodian 1 mailbox ' })).label).toBe(
      'Custodian 1 mailbox',
    );
  });

  it('refuses an empty app password rather than posting it', () => {
    expect(() => buildImapConnector(base({ appPassword: '' }))).toThrow();
  });

  it('refuses an empty username', () => {
    expect(() => buildImapConnector(base({ username: '   ' }))).toThrow();
  });

  it('refuses a custom server with no host', () => {
    expect(() => buildImapConnector(base({ presetId: 'custom', host: '  ' }))).toThrow();
  });

  it('refuses a port that is not a number', () => {
    expect(() =>
      buildImapConnector(base({ presetId: 'custom', host: 'mail.example.com', port: 'abc' })),
    ).toThrow();
  });

  it('never puts the app password anywhere but the appPassword field', () => {
    const body = buildImapConnector(base());
    const elsewhere = JSON.stringify({ ...body, appPassword: undefined });
    expect(elsewhere).not.toContain('abcd efgh ijkl mnop');
  });
});

describe('imapPresetById', () => {
  it('knows Yahoo, iCloud, Gmail, AOL and Outlook', () => {
    for (const id of ['yahoo', 'icloud', 'gmail', 'aol', 'outlook']) {
      expect(imapPresetById(id)).not.toBeNull();
    }
  });

  it('returns null for a custom server', () => {
    expect(imapPresetById('custom')).toBeNull();
  });
});
