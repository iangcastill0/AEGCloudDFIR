import { describe, expect, it } from 'vitest';
import { provider } from './common.js';
import {
  connectorListItem,
  createConnectorRequest,
  createConnectorResponse,
  orgDropboxSetupRequest,
} from './connectors.js';

/**
 * These parse the shapes the API and the web page actually exchange.
 *
 * Four connector bugs in a row here had the same cause: a shape agreed in one
 * place and assumed in another. One of them — `imap` missing from this very
 * enum — silently threw the response away, the operator clicked again, and it
 * created five duplicate connectors.
 */
describe('dropbox is a first-class provider in the contracts', () => {
  it('is accepted by the provider enum', () => {
    // The exact omission that produced five duplicate IMAP connectors.
    expect(provider.safeParse('dropbox').success).toBe(true);
  });

  it('can be created like any other connector', () => {
    const parsed = createConnectorRequest.safeParse({
      provider: 'dropbox',
      mode: 'delegated',
      label: "Jane Doe's Dropbox",
    });
    expect(parsed.success).toBe(true);
  });

  it('still requires a label, which is what broke Connect the first time', () => {
    expect(
      createConnectorRequest.safeParse({ provider: 'dropbox', mode: 'delegated' }).success,
    ).toBe(false);
  });

  it('survives the nested response shape the API really returns', () => {
    // Not a top-level id. The web schema expected one and failed the moment the
    // request stopped being rejected.
    const parsed = createConnectorResponse.safeParse({
      connector: {
        id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
        provider: 'dropbox',
        mode: 'delegated',
        label: 'Dropbox',
        status: 'pending_auth',
        externalIdentity: '',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      authorizationUrl: 'https://www.dropbox.com/oauth2/authorize?client_id=x',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('appears in a connector list without being stripped', () => {
    const parsed = connectorListItem.safeParse({
      id: '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      provider: 'dropbox',
      mode: 'delegated',
      label: 'Dropbox',
      status: 'connected',
      externalIdentity: 'jane@example.com',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('orgDropboxSetupRequest', () => {
  it('takes a team id and the members it may reach', () => {
    const parsed = orgDropboxSetupRequest.safeParse({
      externalTeamId: 'dbtid:AABxyz',
      memberIds: ['dbmid:AAA1', 'dbmid:AAA2'],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an empty member list', () => {
    // A team token can reach every member. Collecting "everyone" because the
    // list was omitted is exactly the over-collection this product exists to
    // avoid, so it has to be named deliberately.
    expect(
      orgDropboxSetupRequest.safeParse({ externalTeamId: 'dbtid:AABxyz', memberIds: [] }).success,
    ).toBe(false);
  });

  it('refuses a missing team id', () => {
    expect(orgDropboxSetupRequest.safeParse({ memberIds: ['dbmid:AAA1'] }).success).toBe(false);
  });
});
