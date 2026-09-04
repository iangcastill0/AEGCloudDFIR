import { describe, expect, it } from 'vitest';
import { chatEvidenceFacts } from './chat-evidence.js';

const MESSAGE = {
  ts: '1697105066.294599',
  user: 'U058T987G3X',
  text: 'Can someone review the Q3 numbers before Friday?',
  thread_ts: '1697105066.294599',
  reply_count: 2,
};

/**
 * Observed on the first collection that actually preserved messages: 4,084
 * items, every one stored as kind `file` and named `C05766F2SCX:1773152773.141959`.
 *
 * Two separate failures of truthfulness. A Slack message is not a file, and the
 * manifest and production load file would say it was. And a reviewer looking at
 * a list of raw channel:timestamp ids cannot tell one message from another, so
 * the collection is technically complete and practically unusable.
 */
describe('chatEvidenceFacts', () => {
  it('records the kind as a chat message, not a file', () => {
    // The EvidenceKind value exists and was migrated onto both databases; not
    // using it left it dead while the manifest called every message a file.
    expect(chatEvidenceFacts('C0123', MESSAGE).kind).toBe('chat_message');
  });

  it('names the item with something a reviewer can read', () => {
    const facts = chatEvidenceFacts('C0123', MESSAGE);
    expect(facts.name).toContain('Can someone review the Q3 numbers');
    expect(facts.name).not.toBe('C0123:1697105066.294599');
  });

  it('keeps the name short enough to scan in a list', () => {
    const long = { ...MESSAGE, text: 'x'.repeat(1000) };
    expect(chatEvidenceFacts('C0123', long).name.length).toBeLessThanOrEqual(200);
  });

  it('falls back to something meaningful when there is no text', () => {
    // Bot posts and attachment-only messages often have empty text. A blank
    // name would make a list of them indistinguishable.
    const facts = chatEvidenceFacts('C0123', { ts: '1697105066.294599', user: 'U1', text: '' });
    expect(facts.name.length).toBeGreaterThan(0);
    expect(facts.name).toContain('C0123');
  });

  it('dates the item from the message, not from when we collected it', () => {
    // primaryDate drives the review timeline and the production sort order. The
    // collection time would order every message identically and destroy the
    // conversation's sequence.
    expect(chatEvidenceFacts('C0123', MESSAGE).primaryDate?.toISOString()).toBe(
      '2023-10-12T10:04:26.295Z',
    );
  });

  it('exposes the message text for extraction and search', () => {
    // Without this the stored native is JSON, nothing is extracted, and a
    // reviewer searching for words in a message finds nothing.
    expect(chatEvidenceFacts('C0123', MESSAGE).text).toContain('Q3 numbers');
  });

  it('records the conversation as the source path', () => {
    expect(chatEvidenceFacts('C0123', MESSAGE).sourcePath).toBe('C0123');
  });

  it('survives a message shape it does not recognise', () => {
    const facts = chatEvidenceFacts('C0123', { ts: 'nonsense' });
    expect(facts.kind).toBe('chat_message');
    expect(facts.primaryDate).toBeNull();
  });
});
