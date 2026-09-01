import { describe, expect, it } from 'vitest';
import { hasUnfetchedThread, messageId, slackTsToIso, summarizeMessage } from './messages.js';

const PARENT = {
  type: 'message',
  ts: '1755645600.123456',
  user: 'U01',
  text: 'Can someone review the Q3 numbers?',
  thread_ts: '1755645600.123456',
  reply_count: 4,
};

const REPLY = {
  type: 'message',
  ts: '1755645720.000200',
  user: 'U02',
  text: 'Looking now',
  thread_ts: '1755645600.123456',
};

const STANDALONE = { type: 'message', ts: '1755645900.000100', user: 'U03', text: 'Morning all' };

describe('slackTsToIso', () => {
  it('converts a Slack ts to an ISO instant', () => {
    // Slack ts is epoch seconds with microseconds, as a string.
    expect(slackTsToIso('1755645600.123456')).toBe('2025-08-19T23:20:00.123Z');
  });

  it('handles a ts with no fractional part', () => {
    expect(slackTsToIso('1755645600')).toBe('2025-08-19T23:20:00.000Z');
  });

  it('returns undefined rather than an epoch date for junk', () => {
    // 1970-01-01 on an evidence timeline is worse than no date at all.
    expect(slackTsToIso('')).toBeUndefined();
    expect(slackTsToIso('not-a-ts')).toBeUndefined();
  });
});

describe('messageId', () => {
  it('is the channel plus the ts, because ts is only unique per channel', () => {
    expect(messageId('C123', '1755645600.123456')).toBe('C123:1755645600.123456');
  });

  it('separates the same ts in two channels', () => {
    expect(messageId('C123', '1.0')).not.toBe(messageId('C999', '1.0'));
  });
});

describe('hasUnfetchedThread', () => {
  /**
   * conversations.history returns thread PARENTS only. The replies are behind
   * conversations.replies, and nothing in the history response hints that they
   * are missing except reply_count. Skipping this loses most of the content of
   * an active workspace while reporting a complete collection.
   */
  it('flags a parent that has replies', () => {
    expect(hasUnfetchedThread(PARENT)).toBe(true);
  });

  it('does not flag a reply — its thread is already being fetched', () => {
    // A reply carries thread_ts too. Treating it as a parent would fetch the
    // same thread once per reply.
    expect(hasUnfetchedThread(REPLY)).toBe(false);
  });

  it('does not flag a parent whose thread is empty', () => {
    expect(hasUnfetchedThread({ ...PARENT, reply_count: 0 })).toBe(false);
    expect(hasUnfetchedThread({ ...PARENT, reply_count: undefined })).toBe(false);
  });

  it('does not flag an ordinary message', () => {
    expect(hasUnfetchedThread(STANDALONE)).toBe(false);
  });
});

describe('summarizeMessage', () => {
  it('records who, when and what', () => {
    const s = summarizeMessage('C123', STANDALONE);
    expect(s.providerItemId).toBe('C123:1755645900.000100');
    expect(s.authorId).toBe('U03');
    expect(s.sentAt).toBe('2025-08-19T23:25:00.000Z');
    expect(s.text).toBe('Morning all');
  });

  it('marks an edited message, because the original text is gone', () => {
    // Slack keeps no history of the previous text. A reviewer reading a message
    // must know they are reading a version, not the words as first sent.
    const s = summarizeMessage('C123', {
      ...STANDALONE,
      edited: { user: 'U03', ts: '1755646000.000100' },
    });
    expect(s.edited).toBe(true);
    expect(s.editedAt).toBe('2025-08-19T23:26:40.000Z');
  });

  it('does not mark an unedited message', () => {
    expect(summarizeMessage('C123', STANDALONE).edited).toBe(false);
  });

  it('keeps a bot message rather than dropping it for having no user', () => {
    // Integrations post real evidence: alerts, deploys, approvals.
    const s = summarizeMessage('C123', {
      type: 'message',
      ts: '1755645900.000100',
      bot_id: 'B01',
      text: 'Deploy finished',
    });
    expect(s.authorId).toBe('B01');
    expect(s.isBot).toBe(true);
  });

  it('records a tombstone as a deletion rather than as empty text', () => {
    // A deleted message is a finding. Recording it as a blank message would
    // hide that something was there.
    const s = summarizeMessage('C123', {
      type: 'message',
      ts: '1755645900.000100',
      subtype: 'tombstone',
      text: '',
    });
    expect(s.deleted).toBe(true);
  });

  it('counts attached files so a missing download is detectable', () => {
    const s = summarizeMessage('C123', {
      ...STANDALONE,
      files: [{ id: 'F1' }, { id: 'F2' }],
    });
    expect(s.fileIds).toEqual(['F1', 'F2']);
  });

  it('links a reply to the thread it belongs to', () => {
    const s = summarizeMessage('C123', REPLY);
    expect(s.threadId).toBe('C123:1755645600.123456');
    expect(s.isThreadReply).toBe(true);
  });
});
