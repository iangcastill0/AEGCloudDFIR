/**
 * Dropbox Business team event log — the provider-side forensic record.
 *
 * `/2/team_log/get_events` returns sign-ins, file views and downloads, sharing
 * changes, membership changes and admin actions across a Dropbox Business team.
 * It is the Dropbox equivalent of the Office 365 Management Activity API and
 * Google's Admin SDK Reports.
 *
 * **Team only, and provably so.** Calling it with a personal account's token
 * returns, verbatim:
 *
 *   HTTP 400 — "This token is not associated with a team"  USER_AUTH_NOT_ALLOWED
 *
 * So a delegated connector can never collect this, and the wizard must not
 * offer it for one. That is a limit of Dropbox, not of this code — worth stating
 * precisely, because "Dropbox has no audit log" is false and this product's
 * value rests on its statements being true.
 *
 * The parsing is pure so it can be tested without a Business team, which is
 * just as well: we do not have one.
 */
import { ensureOk, providerFetch, type FetchLike } from '../http.js';
import type {
  AuditBatch,
  AuditConnector,
  AuditListPage,
  AuditRecordRaw,
  FetchAuditPageOptions,
  RateLimitObserver,
  TokenProvider,
} from '../types.js';

/** The single scope this source exposes: the team's whole event stream. */
export const TEAM_LOG_SCOPE_KEY = 'team_events';

/** Dropbox's own maximum for this endpoint. */
const PAGE_LIMIT = 1000;

export interface RawTeamLogPage {
  events: unknown[];
  cursor: string;
  has_more: boolean;
}

/**
 * The request body for a page.
 *
 * Two shapes, not one: the first call takes filters, and `/continue` takes the
 * cursor ALONE. Sending the filters again with a cursor is an error, and
 * combining them is the obvious thing to write.
 */
export function teamLogRequest(opts: FetchAuditPageOptions): Record<string, unknown> {
  if (opts.cursor !== undefined && opts.cursor !== '') {
    return { cursor: opts.cursor };
  }
  const body: Record<string, unknown> = { limit: PAGE_LIMIT };

  // Dropbox nests the window inside `time`, rather than taking top-level
  // start/end fields the way most APIs do.
  const time: Record<string, string> = {};
  if (opts.since !== undefined && opts.since !== '') time.start_time = opts.since;
  if (opts.until !== undefined && opts.until !== '') time.end_time = opts.until;
  if (Object.keys(time).length > 0) body.time = time;

  // One actor can be expressed; several cannot. Applying just the first would
  // under-collect while still reporting success, so the filter is dropped and
  // everything is collected instead.
  if (opts.actorFilter !== undefined && opts.actorFilter.length === 1) {
    body.account_id = opts.actorFilter[0];
  }
  return body;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return str((value as Record<string, unknown>)['.tag']);
}

/**
 * The person or thing that caused the event.
 *
 * An actor may be a team member, an admin, an app, Dropbox itself, or
 * anonymous. An unrecognised shape must never lose the event — a forensic log
 * with holes in it is worse than one with unattributed rows.
 */
function actorOf(event: Record<string, unknown>): {
  actorId?: string;
  actorEmail?: string;
} {
  const actor = event['actor'];
  if (typeof actor !== 'object' || actor === null) return {};
  const inner =
    (actor as Record<string, unknown>)['user'] ?? (actor as Record<string, unknown>)['admin'];
  if (typeof inner !== 'object' || inner === null) return {};
  const rec = inner as Record<string, unknown>;
  return {
    ...(str(rec['team_member_id'] ?? rec['account_id']) === undefined
      ? {}
      : { actorId: str(rec['team_member_id'] ?? rec['account_id']) as string }),
    ...(str(rec['email']) === undefined ? {} : { actorEmail: str(rec['email']) as string }),
  };
}

function ipOf(event: Record<string, unknown>): string | undefined {
  const origin = event['origin'];
  if (typeof origin !== 'object' || origin === null) return undefined;
  const geo = (origin as Record<string, unknown>)['geo_location'];
  if (typeof geo !== 'object' || geo === null) return undefined;
  return str((geo as Record<string, unknown>)['ip_address']);
}

/** One page of team events, mapped onto the shared audit shape. */
export function mapTeamLogPage(
  page: RawTeamLogPage,
  scopeKey: string,
  rawText: string,
): AuditListPage {
  const records: AuditRecordRaw[] = page.events.map((event, index) => {
    const rec =
      typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : {};
    const occurredAt = str(rec['timestamp']);
    // Dropbox sends no event id. Two events in the same second would otherwise
    // collide on one id and one would be lost to the dedup upsert, so the
    // position within the page disambiguates them.
    const providerRecordId = `${occurredAt ?? 'na'}#${String(index)}`;
    return {
      system: 'dropbox_team_log',
      providerRecordId,
      ...(tag(rec['event_type']) === undefined
        ? {}
        : { operation: tag(rec['event_type']) as string }),
      ...(tag(rec['event_category']) === undefined
        ? {}
        : { workload: tag(rec['event_category']) as string }),
      ...actorOf(rec),
      ...(ipOf(rec) === undefined ? {} : { actorIp: ipOf(rec) as string }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      // The untouched element is the evidence; the fields above are convenience.
      raw: event,
    };
  });

  const batch: AuditBatch = {
    system: 'dropbox_team_log',
    batchId: `${scopeKey}:${page.cursor === '' ? 'initial' : page.cursor}`,
    scopeKey,
    rawBytes: new TextEncoder().encode(rawText),
    contentType: 'application/json',
    records,
    providerReportedCount: page.events.length,
  };

  return {
    batches: [batch],
    ...(page.has_more ? { nextCursor: page.cursor } : {}),
  };
}

/**
 * The audit source itself.
 *
 * Deliberately thin: everything that can be decided without a Dropbox Business
 * team lives in the pure functions above, because a Business team is exactly
 * what we do not have to test against.
 */
export interface DropboxTeamLogOptions {
  tokenProvider: TokenProvider;
  rpcBase?: string;
  fetchImpl?: FetchLike;
  onRateLimit?: RateLimitObserver;
}

export class DropboxTeamLogConnector implements AuditConnector {
  constructor(private readonly options: DropboxTeamLogOptions) {}

  /**
   * One scope. Unlike Microsoft content types or Google applications, Dropbox
   * returns every category in a single stream, and `event_category` on each
   * record is what separates them afterwards.
   */
  listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    return Promise.resolve([{ scopeKey: TEAM_LOG_SCOPE_KEY, label: 'Dropbox team events' }]);
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    const continuing = opts.cursor !== undefined && opts.cursor !== '';
    const base = this.options.rpcBase ?? 'https://api.dropboxapi.com/2';
    const url = `${base}/team_log/get_events${continuing ? '/continue' : ''}`;

    const response = await providerFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(teamLogRequest(opts)),
      },
      {
        tokenProvider: this.options.tokenProvider,
        provider: 'dropbox',
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        ...(this.options.onRateLimit === undefined
          ? {}
          : { onRateLimit: this.options.onRateLimit }),
      },
    );
    await ensureOk(
      response,
      `dropbox ${continuing ? 'team_log/get_events/continue' : 'team_log/get_events'}`,
    );

    // Read as text first: these bytes ARE the evidence, and re-serializing a
    // parsed object would change them.
    const rawText = await response.text();
    const parsed = JSON.parse(rawText) as RawTeamLogPage;
    return mapTeamLogPage(parsed, scopeKey, rawText);
  }
}
