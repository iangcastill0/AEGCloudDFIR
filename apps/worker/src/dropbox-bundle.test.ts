import { describe, expect, it } from 'vitest';
import { requireDrive, requireEmail, type ConnectorBundle } from './connector-factory.js';

function bundle(over: Partial<ConnectorBundle> = {}): ConnectorBundle {
  return {
    provider: 'dropbox',
    mode: 'delegated',
    email: null,
    drive: {} as ConnectorBundle['drive'],
    custodianRef: 'me',
    ...over,
  } as ConnectorBundle;
}

/**
 * The rule both guards enforce: a source a connector cannot reach must fail
 * loudly. A stub that quietly returns nothing would let a collection report
 * that it looked at mail, or at files, that it never touched — and the
 * completeness narrative would be a lie a reviewer relies on.
 */
describe('a Dropbox bundle refuses mail rather than pretending', () => {
  it('throws when a collection selects mail on a files-only connector', () => {
    expect(() => requireEmail(bundle())).toThrow(/dropbox/i);
    expect(() => requireEmail(bundle())).toThrow(/files only/i);
  });

  it('hands back the drive client, which is what Dropbox does have', () => {
    expect(requireDrive(bundle())).toBeDefined();
  });

  it('is the mirror of the existing mail-only rule', () => {
    // IMAP has no drive; Dropbox has no mailbox. Same failure, opposite side.
    const imap = bundle({ provider: 'imap', email: {} as ConnectorBundle['email'], drive: null });
    expect(() => requireDrive(imap)).toThrow(/mail only/i);
    expect(requireEmail(imap)).toBeDefined();
  });
});
