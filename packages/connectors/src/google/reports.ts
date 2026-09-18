/**
 * Google Workspace Admin SDK Reports connector (READ-ONLY audit activities).
 *
 * DWD scope: admin.reports.audit.readonly, via a service-account token source
 * impersonating an admin (the token source enforces the domain allowlist).
 *
 * Each activities page becomes ONE AuditBatch: rawBytes = the untouched page
 * JSON. Reports nests events under activity items (one actor + N events); the
 * connector flattens each event into its own AuditRecordRaw. Paging follows
 * nextPageToken, carried as the cursor.
 */
import { z } from 'zod';
import {
  ensureOk,
  providerFetch,
  type FetchLike,
  type ProviderFetchOptions,
  type RetryPolicy,
} from '../http.js';
import {
  AuditConfigError,
  type AuditBatch,
  type AuditConnector,
  type AuditListPage,
  type AuditRecordRaw,
  type FetchAuditPageOptions,
  type RateLimitObserver,
  type TokenProvider,
} from '../types.js';
import { normalizeBaseUrl } from './common.js';

const DEFAULT_GOOGLE_API_BASE_URL = 'https://admin.googleapis.com';

/**
 * The full Admin SDK Reports application catalog this connector can enumerate,
 * mirroring the set a comprehensive Workspace acquisition covers. Not every
 * application is enabled in every tenant — the Reports API answers 400 for one
 * that is not, which the worker records as a per-scope exception and skips
 * (the collection is `complete_with_exceptions`, never silently short).
 *
 * `gmail` is included but is special: its events all carry the constant
 * eventName `delivery`, the real action is the nested `event_info.mail_event_type`
 * (e.g. 31 = "Message viewed"), and each query is capped to a <=30-day window
 * (see fetchAuditPage). All applications share the Reports API's 180-day retention.
 */
export const GOOGLE_REPORTS_APPLICATIONS: readonly string[] = [
  'login',
  'admin',
  'drive',
  'token',
  'user_accounts',
  'mobile',
  'groups',
  'groups_enterprise',
  'saml',
  'calendar',
  'chat',
  'meet',
  'chrome',
  'gcp',
  'gplus',
  'rules',
  'context_aware_access',
  'access_transparency',
  'keep',
  'vault',
  'classroom',
  'data_studio',
  'gemini_in_workspace_apps',
  'jamboard',
  'meet_hardware',
  'ldap',
  'profile',
  'tasks',
  'contacts',
  'cloud_search',
  'data_migration',
  'directory_sync',
  'admin_data_action',
  'access_evaluation',
  'assignments',
  'gmail',
];

/** Sensible core pre-checked in the collection wizard's audit-scope step. */
export const GOOGLE_REPORTS_DEFAULT_APPLICATIONS: readonly string[] = [
  'login',
  'admin',
  'drive',
  'token',
  'user_accounts',
  'gmail',
];

/** The one application whose events need mail_event_type decoding + windowing. */
export const GOOGLE_REPORTS_GMAIL_APPLICATION = 'gmail';

/** Gmail queries are capped to this window per request; retention is 180 days. */
export const GMAIL_MAX_RANGE_DAYS = 30;

/**
 * Gmail `event_info.mail_event_type` code -> human label. Gmail audit events all
 * report eventName `delivery`; this integer is the real action. Source: Google
 * "Gmail Activity Events" / "Schema for Gmail logs in BigQuery".
 */
export const GMAIL_MAIL_EVENT_TYPES: Readonly<Record<string, string>> = {
  '1': 'Message sent',
  '2': 'Message received',
  '3': 'User classified message as spam',
  '4': 'Gmail flagged message as spam',
  '5': 'Message quarantined',
  '6': 'Message released from quarantine',
  '7': 'Message opened (first time)',
  '8': 'Message marked as unread',
  '9': 'Message replied to (first time)',
  '10': 'Message forwarded (first time)',
  '11': 'Message autoforwarded',
  '12': 'Message moved to Inbox',
  '13': 'Message moved to Trash',
  '14': 'Message removed from Trash',
  '15': 'Link in message body clicked',
  '16': 'Attachment link clicked in preview',
  '17': 'Attachments downloaded',
  '18': 'Attachments saved to Drive',
  '19': 'Drive items in message saved to Drive',
  '20': 'Classification label applied to message',
  '21': 'Message classification label changed',
  '22': 'Classification label removed from message',
  '23': 'Classification label applied to attachments',
  '24': 'Classification label changed on attachments',
  '25': 'Classification label removed from attachments',
  '26': 'Message archived',
  '27': 'Message permanently deleted',
  '28': 'Attachments previewed',
  '29': 'Message saved as draft',
  '30': 'Message bounced (undeliverable)',
  '31': 'Message viewed',
  '32': 'Message downloaded (POP3)',
  '33': 'Application accessed message on behalf of user',
  '34': 'Receive rate limited',
  '35': 'Email send process initiated',
};

export interface GoogleReportsOptions {
  tokenProvider: TokenProvider;
  /** Defaults to https://admin.googleapis.com (override for the fake server). */
  googleApiBaseUrl?: string;
  /** The applications selected for this connection. */
  applications: readonly string[];
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

const eventSchema = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  parameters: z.array(z.unknown()).optional(),
});

const activitySchema = z.object({
  id: z.object({
    time: z.string().optional(),
    uniqueQualifier: z.union([z.string(), z.number()]).optional(),
    applicationName: z.string().optional(),
    customerId: z.string().optional(),
  }),
  actor: z.object({ email: z.string().optional(), profileId: z.string().optional() }).optional(),
  ipAddress: z.string().optional(),
  events: z.array(eventSchema).default([]),
});

const activitiesPageSchema = z.object({
  items: z.array(activitySchema).default([]),
  nextPageToken: z.string().optional(),
});

/**
 * Reports API parameters are a tree: a parameter may carry a scalar
 * (`value`/`intValue`/`boolValue`) or nest more parameters under `messageValue`
 * or `multiMessageValue`. Find the first scalar for `name` anywhere in the tree.
 * Used to pull Gmail's `event_info.mail_event_type` and message id out of the
 * `event_info` / `message_info` message parameters.
 */
function findParamValue(parameters: unknown, name: string): string | undefined {
  if (!Array.isArray(parameters)) return undefined;
  for (const entry of parameters) {
    if (typeof entry !== 'object' || entry === null) continue;
    const param = entry as Record<string, unknown>;
    if (param['name'] === name) {
      if (typeof param['value'] === 'string') return param['value'];
      if (typeof param['intValue'] === 'string') return param['intValue'];
      if (typeof param['intValue'] === 'number') return String(param['intValue']);
      if (typeof param['boolValue'] === 'boolean') return String(param['boolValue']);
    }
    const mv = param['messageValue'];
    if (mv !== null && typeof mv === 'object') {
      const nested = findParamValue((mv as Record<string, unknown>)['parameter'], name);
      if (nested !== undefined) return nested;
    }
    const mmv = param['multiMessageValue'];
    if (Array.isArray(mmv)) {
      for (const mm of mmv) {
        if (mm !== null && typeof mm === 'object') {
          const nested = findParamValue((mm as Record<string, unknown>)['parameter'], name);
          if (nested !== undefined) return nested;
        }
      }
    }
  }
  return undefined;
}

export class GoogleReportsConnector implements AuditConnector {
  private readonly base: string;
  private readonly options: GoogleReportsOptions;

  constructor(options: GoogleReportsOptions) {
    this.options = options;
    this.base = normalizeBaseUrl(options.googleApiBaseUrl ?? DEFAULT_GOOGLE_API_BASE_URL);
  }

  private fetchOptions(): ProviderFetchOptions {
    return {
      tokenProvider: this.options.tokenProvider,
      provider: 'google',
      retry: this.options.retry,
      onRateLimit: this.options.onRateLimit,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      sleepImpl: this.options.sleepImpl,
      randomImpl: this.options.randomImpl,
    };
  }

  private get(url: string): Promise<Response> {
    return providerFetch(url, { method: 'GET' }, this.fetchOptions());
  }

  listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    return Promise.resolve(this.options.applications.map((a) => ({ scopeKey: a, label: a })));
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    const isGmail = scopeKey === GOOGLE_REPORTS_GMAIL_APPLICATION;
    if (isGmail) {
      // Gmail is the one application the Reports API refuses without a bounded
      // window, and caps to 30 days per query. Enforce it here so a missing or
      // too-wide window fails clearly instead of returning a confusing empty
      // page. The worker pages the requested range in <=30-day slices.
      if (opts.since === undefined || opts.until === undefined) {
        throw new AuditConfigError(
          'gmail audit logs require both since and until (max 30-day window)',
        );
      }
      const spanMs = Date.parse(opts.until) - Date.parse(opts.since);
      if (Number.isNaN(spanMs)) {
        throw new AuditConfigError('gmail since/until must be valid ISO-8601 timestamps');
      }
      if (spanMs < 0) {
        throw new AuditConfigError('gmail since must be before until');
      }
      if (spanMs > GMAIL_MAX_RANGE_DAYS * 86_400_000) {
        throw new AuditConfigError(
          `gmail audit logs support at most a ${GMAIL_MAX_RANGE_DAYS}-day window per query`,
        );
      }
    }
    // A single actor narrows the report to one user; otherwise all users.
    const userKey =
      opts.actorFilter !== undefined && opts.actorFilter.length === 1
        ? (opts.actorFilter[0] as string)
        : 'all';
    const u = new URL(
      `${this.base}/admin/reports/v1/activity/users/${encodeURIComponent(userKey)}/applications/${encodeURIComponent(scopeKey)}`,
    );
    u.searchParams.set('maxResults', '1000');
    if (opts.since !== undefined) u.searchParams.set('startTime', opts.since);
    if (opts.until !== undefined) u.searchParams.set('endTime', opts.until);
    if (opts.cursor !== undefined) u.searchParams.set('pageToken', opts.cursor);

    const res = await ensureOk(await this.get(u.toString()), 'fetchAuditPage');
    const text = await res.text();
    const parsedJson: unknown = JSON.parse(text);
    const page = activitiesPageSchema.parse(parsedJson);
    const rawBytes = new TextEncoder().encode(text);

    // Preserve the untouched event objects (zod parsing strips unknown keys).
    const rawItems =
      typeof parsedJson === 'object' && parsedJson !== null
        ? (((parsedJson as Record<string, unknown>)['items'] as unknown[] | undefined) ?? [])
        : [];

    const records: AuditRecordRaw[] = [];
    page.items.forEach((activity, itemIndex) => {
      const rawActivity = rawItems[itemIndex];
      const rawEvents =
        typeof rawActivity === 'object' && rawActivity !== null
          ? ((rawActivity as Record<string, unknown>)['events'] as unknown[] | undefined)
          : undefined;
      const qualifier = activity.id.uniqueQualifier;
      const time = activity.id.time;
      activity.events.forEach((event, eventIndex) => {
        const idBase = `${qualifier !== undefined ? String(qualifier) : 'na'}:${time ?? 'na'}`;
        // A qualifier+time pair can host several events; disambiguate by index.
        const providerRecordId = activity.events.length > 1 ? `${idBase}#${eventIndex}` : idBase;

        // Gmail hides the real action in event_info.mail_event_type; eventName is
        // always "delivery". Decode it so "Message viewed" (31), "Message opened"
        // (7), etc. become the operation and are filterable in Review, and carry
        // the message id as the target. Other applications keep name/type as-is.
        let operation = event.name;
        let recordType = event.type;
        let targetId: string | undefined;
        if (isGmail) {
          const mailType = findParamValue(event.parameters, 'mail_event_type');
          if (mailType !== undefined) {
            operation = GMAIL_MAIL_EVENT_TYPES[mailType] ?? `mail_event_type ${mailType}`;
            recordType = `gmail_mail_event:${mailType}`;
          }
          targetId =
            findParamValue(event.parameters, 'rfc2822_message_id') ??
            findParamValue(event.parameters, 'message_id');
        }

        records.push({
          system: 'google_reports',
          providerRecordId,
          operation,
          recordType,
          workload: activity.id.applicationName ?? scopeKey,
          actorEmail: activity.actor?.email,
          actorId: activity.actor?.profileId,
          actorIp: activity.ipAddress,
          ...(targetId !== undefined ? { targetId } : {}),
          occurredAt: time,
          raw: rawEvents?.[eventIndex] ?? event,
        });
      });
    });

    const batch: AuditBatch = {
      system: 'google_reports',
      batchId: `${scopeKey}:${opts.cursor ?? 'initial'}`,
      scopeKey,
      rawBytes,
      contentType: 'application/json',
      records,
      providerReportedCount: page.items.length,
    };

    return { batches: [batch], nextCursor: page.nextPageToken };
  }
}
