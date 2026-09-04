/**
 * What a preserved chat message is, as evidence.
 *
 * Observed on the first collection that actually preserved messages: 4,084
 * items, every one stored as kind `file` and named
 * `C05766F2SCX:1773152773.141959`.
 *
 * Two separate failures, both of truthfulness rather than of code. A Slack
 * message is not a file, and the manifest and the production load file would
 * have said it was — the whole reason `chat_message` was added to the enum and
 * migrated onto both databases. And a reviewer facing a list of raw
 * channel:timestamp ids cannot tell one message from another, which makes a
 * technically complete collection practically unusable.
 *
 * Pure, so none of it needs a workspace to test.
 */
import { slackTsToIso, type RawSlackMessage } from '@aeg-clouddfir/connectors';

/** Longest name that still scans in a result list. */
const MAX_NAME = 200;

export interface ChatEvidenceFacts {
  kind: 'chat_message';
  name: string;
  /** When the message was SENT, not when it was collected. */
  primaryDate: Date | null;
  /** The message text, for extraction and search. */
  text: string;
  /** The conversation it belongs to. */
  sourcePath: string;
}

function firstLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_NAME ? `${line.slice(0, MAX_NAME - 1)}…` : line;
}

export function chatEvidenceFacts(
  conversationId: string,
  message: RawSlackMessage,
): ChatEvidenceFacts {
  const ts = message.ts ?? '';
  const iso = ts === '' ? undefined : slackTsToIso(ts);
  const text = message.text ?? '';

  // Bot posts and attachment-only messages often carry no text at all. A blank
  // name would make a list of them indistinguishable, so the identity is used
  // as a last resort rather than nothing.
  const name = text.trim() === '' ? `${conversationId}:${ts}` : firstLine(text);

  return {
    kind: 'chat_message',
    name,
    // The SENT time, because primaryDate drives the review timeline and the
    // production sort order. Using the collection time would stamp every
    // message identically and destroy the sequence of the conversation, which
    // is most of what a chat log is evidence of.
    primaryDate: iso === undefined ? null : new Date(iso),
    text,
    sourcePath: conversationId,
  };
}
