/**
 * Slack messages, and the three ways a naive reading of them loses evidence.
 *
 * 1. **Threads are not in the history.** `conversations.history` returns thread
 *    PARENTS only; the replies are behind `conversations.replies`. Nothing in
 *    the history response says the replies are missing except `reply_count`.
 *    In an active workspace most of the content is in threads, so skipping this
 *    collects a fraction of the conversation and reports success.
 *
 * 2. **Edits leave no trace of the original.** Slack keeps no history of the
 *    previous text: the message you fetch IS the edited version. A reviewer has
 *    to be told they are reading a revision, because nothing else will tell
 *    them.
 *
 * 3. **A `ts` is only unique within a channel.** Two channels can hold the same
 *    ts, so identity has to carry the channel.
 *
 * Pure: none of this needs a workspace to test.
 */

export interface RawSlackMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  edited?: { user?: string; ts?: string };
  files?: { id?: string }[];
}

/**
 * A Slack `ts` as an ISO instant.
 *
 * Undefined rather than a fallback for anything unparseable: a 1970 timestamp
 * on an evidence timeline is worse than a blank one, and quietly plausible.
 */
export function slackTsToIso(ts: string): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(ts)) return undefined;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/** Identity of a message. The channel is part of it; a ts alone is not unique. */
export function messageId(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/**
 * Does this message have replies that `conversations.history` did not return?
 *
 * True only for a thread PARENT with a non-zero reply count. A reply carries
 * `thread_ts` as well, and treating it as a parent would re-fetch the same
 * thread once per reply.
 */
export function hasUnfetchedThread(message: RawSlackMessage): boolean {
  const ts = message.ts;
  if (ts === undefined || message.thread_ts === undefined) return false;
  if (message.thread_ts !== ts) return false; // a reply, not the parent
  return (message.reply_count ?? 0) > 0;
}

export interface SlackMessageSummary {
  providerItemId: string;
  channelId: string;
  ts: string;
  /** User id, or the bot id when an integration posted it. */
  authorId: string;
  isBot: boolean;
  sentAt?: string;
  text: string;
  edited: boolean;
  editedAt?: string;
  deleted: boolean;
  isThreadReply: boolean;
  threadId?: string;
  fileIds: string[];
}

export function summarizeMessage(channelId: string, message: RawSlackMessage): SlackMessageSummary {
  const ts = message.ts ?? '';
  const sentAt = ts === '' ? undefined : slackTsToIso(ts);
  const editedTs = message.edited?.ts;
  const editedAt = editedTs === undefined ? undefined : slackTsToIso(editedTs);
  const isReply = message.thread_ts !== undefined && message.thread_ts !== ts;

  return {
    providerItemId: messageId(channelId, ts),
    channelId,
    ts,
    // A bot message is real evidence — alerts, deploys, approvals — so it keeps
    // the bot id rather than being dropped for having no user.
    authorId: message.user ?? message.bot_id ?? '',
    isBot: message.user === undefined && message.bot_id !== undefined,
    ...(sentAt === undefined ? {} : { sentAt }),
    text: message.text ?? '',
    edited: message.edited !== undefined,
    ...(editedAt === undefined ? {} : { editedAt }),
    // A deleted message is a finding. Recorded as blank text it would look like
    // an empty message rather than a removal.
    deleted: message.subtype === 'tombstone',
    isThreadReply: isReply,
    ...(message.thread_ts === undefined
      ? {}
      : { threadId: messageId(channelId, message.thread_ts) }),
    fileIds: (message.files ?? [])
      .map((f) => f.id)
      .filter((id): id is string => typeof id === 'string'),
  };
}
