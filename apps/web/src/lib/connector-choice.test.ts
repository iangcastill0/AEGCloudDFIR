import { describe, expect, it } from 'vitest';
import { connectorChoiceLabel, type ChoosableConnector } from './connector-choice';

function c(over: Partial<ChoosableConnector> = {}): ChoosableConnector {
  return {
    id: 'd9b52818-1ff8-4aea-8f5a-a2fbe6dc4346',
    provider: 'imap',
    mode: 'delegated',
    label: 'iancastillo790@yahoo.com (IMAP) 2026-08-27',
    externalIdentity: 'iancastillo790@yahoo.com',
    status: 'pending_auth',
    createdAt: '2026-08-27T19:20:58.989Z',
    ...over,
  };
}

describe('connectorChoiceLabel', () => {
  it('stays plain when the mailbox appears once', () => {
    const one = c();
    expect(connectorChoiceLabel(one, [one])).toBe('iancastillo790@yahoo.com (personal/delegated)');
  });

  it('adds the time added when the same mailbox appears more than once', () => {
    // The real case: four connectors to the same Yahoo mailbox rendered as four
    // identical rows, so choosing one was a guess.
    const a = c({ id: 'aaaa1111-0000-4000-8000-000000000001' });
    const b = c({
      id: 'bbbb2222-0000-4000-8000-000000000002',
      createdAt: '2026-08-27T19:58:34.521Z',
    });
    const labels = [a, b].map((x) => connectorChoiceLabel(x, [a, b]));
    expect(labels[0]).toContain('added');
    expect(labels[1]).toContain('added');
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('falls back to a short id when there is no created date', () => {
    const a = c({ id: 'aaaa1111-0000-4000-8000-000000000001', createdAt: undefined });
    const b = c({ id: 'bbbb2222-0000-4000-8000-000000000002', createdAt: undefined });
    expect(connectorChoiceLabel(a, [a, b])).toContain('aaaa1111');
  });

  it('uses the label when there is no provider identity yet', () => {
    const a = c({ externalIdentity: '', label: 'Custodian 1 mailbox' });
    expect(connectorChoiceLabel(a, [a])).toContain('Custodian 1 mailbox');
  });
});
