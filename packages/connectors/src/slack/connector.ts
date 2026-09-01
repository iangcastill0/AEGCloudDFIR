/**
 * Slack chat collection, tier 1: a regular workspace with a user token.
 *
 * The reach of this tier is exactly what the authorising user can see — public
 * channels, plus the private channels and DMs they are a member of. It cannot
 * reach a channel they are not in. That is a real limit of the access granted,
 * and it belongs in the completeness narrative rather than a footnote, because
 * a collection that is silently partial is the failure this product exists to
 * avoid.
 *
 * Enterprise Grid (`discovery.*`, every conversation including DMs) is a
 * separate tier and a separate ADR: shipping it without a Grid tenant to test
 * against would repeat a mistake this project has already made twice.
 */
import { ConnectorError } from '../types.js';
import type { FetchLike } from '../http.js';
import { SlackClient, type SlackClientOptions } from './api.js';
import { hasUnfetchedThread, summarizeMessage, type RawSlackMessage } from './messages.js';

export interface SlackConversation {
  id: string;
  name: string;
  kind: 'public_channel' | 'private_channel' | 'mpim' | 'im';
  archived: boolean;
  /** True when the authorising user is a member; false means unreadable here. */
  isMember: boolean;
  topic: string;
  purpose: string;
  createdAt?: string;
}

export interface SlackConversationScope {
  includePublic: boolean;
  includePrivate: boolean;
  includeDms: boolean;
  includeGroupDms: boolean;
  includeArchived: boolean;
}

/** Slack's `types` parameter for the scope the operator chose. */
export function conversationTypes(scope: SlackConversationScope): string {
  const types: string[] = [];
  if (scope.includePublic) types.push('public_channel');
  if (scope.includePrivate) types.push('private_channel');
  if (scope.includeGroupDms) types.push('mpim');
  // DMs are opt-in and default off elsewhere: reaching a custodian's private
  // messages is a materially larger intrusion than reading a public channel.
  if (scope.includeDms) types.push('im');
  return types.join(',');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function mapConversation(raw: Record<string, unknown>): SlackConversation {
  const isIm = raw['is_im'] === true;
  const isMpim = raw['is_mpim'] === true;
  const isPrivate = raw['is_private'] === true;
  const created = typeof raw['created'] === 'number' ? raw['created'] : undefined;
  return {
    id: str(raw['id']),
    // A DM has no name. The counterpart's user id is the only identifier Slack
    // gives, and inventing a friendly name here would be a guess.
    name: isIm ? `dm:${str(raw['user'])}` : str(raw['name']),
    kind: isIm ? 'im' : isMpim ? 'mpim' : isPrivate ? 'private_channel' : 'public_channel',
    archived: raw['is_archived'] === true,
    isMember: raw['is_member'] === true || isIm || isMpim,
    topic: str((raw['topic'] as Record<string, unknown> | undefined)?.['value']),
    purpose: str((raw['purpose'] as Record<string, unknown> | undefined)?.['value']),
    ...(created === undefined ? {} : { createdAt: new Date(created * 1000).toISOString() }),
  };
}

export interface SlackConnectorOptions extends SlackClientOptions {
  fetchImpl?: FetchLike;
}

export class SlackChatConnector {
  private readonly api: SlackClient;

  constructor(options: SlackConnectorOptions) {
    this.api = new SlackClient(options);
  }

  /** Who this token belongs to. Recorded so the wrong-custodian case is visible. */
  async identify(): Promise<{ userId: string; user: string; teamId: string; team: string }> {
    const body = await this.api.call('auth.test', {});
    return {
      userId: str(body['user_id']),
      user: str(body['user']),
      teamId: str(body['team_id']),
      team: str(body['team']),
    };
  }

  async listConversations(scope: SlackConversationScope): Promise<SlackConversation[]> {
    const types = conversationTypes(scope);
    if (types === '') return [];
    const out: SlackConversation[] = [];
    for await (const page of this.api.paginate(
      'conversations.list',
      { types, exclude_archived: !scope.includeArchived },
      'channels',
    )) {
      for (const raw of page) {
        if (typeof raw !== 'object' || raw === null) continue;
        out.push(mapConversation(raw as Record<string, unknown>));
      }
    }
    return out;
  }

  /**
   * One page of a conversation's messages, plus every reply to any thread the
   * page contains.
   *
   * The thread fetch is the point. `conversations.history` returns parents
   * only, and in an active workspace most of the content is in the replies, so
   * a page taken at face value collects a fraction and reports it complete.
   */
  async fetchMessagePage(
    channelId: string,
    opts: { cursor?: string; oldest?: string; latest?: string } = {},
  ): Promise<{ messages: RawSlackMessage[]; nextCursor?: string; threadsFetched: number }> {
    const body = await this.api.call('conversations.history', {
      channel: channelId,
      limit: 200,
      cursor: opts.cursor,
      oldest: opts.oldest,
      latest: opts.latest,
      // Slack omits thread replies from history regardless; asking for them
      // inline is not an option, so they are fetched per parent below.
      inclusive: true,
    });
    const raw = body['messages'];
    if (!Array.isArray(raw)) {
      throw new ConnectorError('slack conversations.history: response has no "messages" array');
    }
    const messages = raw as RawSlackMessage[];

    const collected: RawSlackMessage[] = [...messages];
    let threadsFetched = 0;
    for (const message of messages) {
      if (!hasUnfetchedThread(message) || message.ts === undefined) continue;
      threadsFetched += 1;
      for await (const page of this.api.paginate(
        'conversations.replies',
        { channel: channelId, ts: message.ts },
        'messages',
      )) {
        for (const reply of page as RawSlackMessage[]) {
          // replies includes the parent as its first element; keeping it would
          // duplicate the message under the same id.
          if (reply.ts === message.ts) continue;
          collected.push(reply);
        }
      }
    }

    const cursor = body['response_metadata'];
    const nextCursor =
      typeof cursor === 'object' && cursor !== null
        ? (cursor as Record<string, unknown>)['next_cursor']
        : undefined;

    return {
      messages: collected,
      ...(typeof nextCursor === 'string' && nextCursor.length > 0 ? { nextCursor } : {}),
      threadsFetched,
    };
  }

  /** Summaries for a page, in the shape the rest of the pipeline speaks. */
  summarize(channelId: string, messages: readonly RawSlackMessage[]) {
    return messages.map((m) => summarizeMessage(channelId, m));
  }
}
