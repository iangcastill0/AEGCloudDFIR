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

/** The Reports applications this connector can enumerate. */
export const GOOGLE_REPORTS_APPLICATIONS: readonly string[] = [
  'login',
  'drive',
  'admin',
  'token',
  'mobile',
  'user_accounts',
  'groups',
  'saml',
];

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
  actor: z
    .object({ email: z.string().optional(), profileId: z.string().optional() })
    .optional(),
  ipAddress: z.string().optional(),
  events: z.array(eventSchema).default([]),
});

const activitiesPageSchema = z.object({
  items: z.array(activitySchema).default([]),
  nextPageToken: z.string().optional(),
});

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
        ? ((parsedJson as Record<string, unknown>)['items'] as unknown[] | undefined) ?? []
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
        const providerRecordId =
          activity.events.length > 1 ? `${idBase}#${eventIndex}` : idBase;
        records.push({
          system: 'google_reports',
          providerRecordId,
          operation: event.name,
          recordType: event.type,
          workload: activity.id.applicationName ?? scopeKey,
          actorEmail: activity.actor?.email,
          actorId: activity.actor?.profileId,
          actorIp: activity.ipAddress,
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
