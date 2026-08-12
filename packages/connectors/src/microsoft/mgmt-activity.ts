/**
 * Office 365 Management Activity API connector (READ-ONLY audit content feed).
 *
 * App token scope: https://manage.office.com/.default (ActivityFeed.Read).
 *
 * Flow:
 *  1. ensureSubscriptions() starts the content subscription per content type
 *     (idempotent: an "already enabled" 400/AF20024 is treated as success).
 *  2. fetchAuditPage() reads the content list for a content type over a time
 *     window, then downloads each referenced content blob and assembles ONE
 *     AuditBatch per blob (rawBytes = the untouched blob JSON, records = the
 *     parsed Unified Audit Log elements).
 *
 * Cursor semantics (opaque to callers; base64url JSON):
 *   { pageUri?: string, pendingSubranges: { start; end }[] }
 * - The Management API rejects windows wider than 24h, so a [since,until]
 *   range wider than a day is split into <=24h subranges. The FIRST subrange is
 *   fetched immediately; the remainder ride along in `pendingSubranges`.
 * - Within a subrange, provider paging is driven by the `NextPageUri` response
 *   header, carried forward as `pageUri`.
 * - When a subrange is exhausted (no NextPageUri) and subranges remain, the
 *   next call pops the next subrange (pageUri absent). When neither remains,
 *   nextCursor is undefined.
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

export const O365_MANAGEMENT_CONTENT_TYPES: readonly string[] = [
  'Audit.Exchange',
  'Audit.SharePoint',
  'Audit.AzureActiveDirectory',
  'Audit.General',
  'DLP.All',
];

const DEFAULT_MANAGEMENT_BASE_URL = 'https://manage.office.com/api/v1.0';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface O365ManagementActivityOptions {
  tokenProvider: TokenProvider;
  tenantId: string;
  /** Defaults to https://manage.office.com/api/v1.0 (override for the fake server). */
  managementBaseUrl?: string;
  /** The content types selected for this connection. */
  contentTypes: readonly string[];
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

interface Subrange {
  start: string;
  end: string;
}

const subrangeSchema = z.object({ start: z.string(), end: z.string() });
const cursorSchema = z.object({
  pageUri: z.string().optional(),
  pendingSubranges: z.array(subrangeSchema).default([]),
});
type MgmtCursor = z.infer<typeof cursorSchema>;

/** Content-list element (one downloadable audit blob descriptor). */
const contentListItemSchema = z.object({
  contentType: z.string().optional(),
  contentId: z.string(),
  contentUri: z.string(),
  contentCreated: z.string().optional(),
  contentExpiration: z.string().optional(),
});
const contentListSchema = z.array(contentListItemSchema);

/** Typed view of a Unified Audit Log element; extras are preserved via raw. */
const ualSchema = z.object({
  Id: z.string(),
  RecordType: z.union([z.number(), z.string()]).optional(),
  CreationTime: z.string().optional(),
  Operation: z.string().optional(),
  Workload: z.string().optional(),
  UserId: z.string().optional(),
  ClientIP: z.string().optional(),
  ClientIPAddress: z.string().optional(),
  ActorIpAddress: z.string().optional(),
  ObjectId: z.string().optional(),
  ResultStatus: z.string().optional(),
});

/** Management API expects UTC datetimes without milliseconds (yyyy-MM-ddTHH:mm:ss). */
function toManagementTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

function extractErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

function encodeCursor(cursor: MgmtCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): MgmtCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AuditConfigError('malformed Management Activity cursor');
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new AuditConfigError('malformed Management Activity cursor');
  return result.data;
}

export class O365ManagementActivityConnector implements AuditConnector {
  private readonly base: string;
  private readonly options: O365ManagementActivityOptions;

  constructor(options: O365ManagementActivityOptions) {
    this.options = options;
    this.base = normalizeBaseUrl(options.managementBaseUrl ?? DEFAULT_MANAGEMENT_BASE_URL);
  }

  private fetchOptions(): ProviderFetchOptions {
    return {
      tokenProvider: this.options.tokenProvider,
      provider: 'microsoft',
      retry: this.options.retry,
      onRateLimit: this.options.onRateLimit,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs,
      sleepImpl: this.options.sleepImpl,
      randomImpl: this.options.randomImpl,
    };
  }

  private request(url: string, method: 'GET' | 'POST'): Promise<Response> {
    return providerFetch(url, { method }, this.fetchOptions());
  }

  listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    return Promise.resolve(
      this.options.contentTypes.map((ct) => ({ scopeKey: ct, label: ct })),
    );
  }

  /**
   * Start the content subscription for every configured content type. Starting
   * an already-enabled subscription returns 400/AF20024, which is a success.
   */
  async ensureSubscriptions(): Promise<void> {
    for (const contentType of this.options.contentTypes) {
      const url =
        `${this.base}/${encodeURIComponent(this.options.tenantId)}` +
        `/activity/feed/subscriptions/start?contentType=${encodeURIComponent(contentType)}`;
      const res = await this.request(url, 'POST');
      if (res.ok) continue;
      if (res.status === 400) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        if (extractErrorCode(body) === 'AF20024') continue; // already enabled
      }
      await ensureOk(res, `ensureSubscriptions(${contentType})`);
    }
  }

  private contentUrl(contentType: string, subrange?: Subrange): string {
    const u = new URL(
      `${this.base}/${encodeURIComponent(this.options.tenantId)}/activity/feed/subscriptions/content`,
    );
    u.searchParams.set('contentType', contentType);
    if (subrange !== undefined) {
      u.searchParams.set('startTime', subrange.start);
      u.searchParams.set('endTime', subrange.end);
    }
    return u.toString();
  }

  private splitWindows(since: string, until: string): Subrange[] {
    const startMs = Date.parse(since);
    const endMs = Date.parse(until);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      throw new AuditConfigError('since/until must be valid ISO-8601 timestamps');
    }
    if (startMs >= endMs) {
      throw new AuditConfigError('since must be strictly before until');
    }
    const windows: Subrange[] = [];
    let cursor = startMs;
    while (cursor < endMs) {
      const next = Math.min(cursor + DAY_MS, endMs);
      windows.push({ start: toManagementTime(cursor), end: toManagementTime(next) });
      cursor = next;
    }
    return windows;
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    let currentUri: string;
    let pending: Subrange[];

    if (opts.cursor !== undefined) {
      const cursor = decodeCursor(opts.cursor);
      pending = cursor.pendingSubranges;
      if (cursor.pageUri !== undefined) {
        currentUri = cursor.pageUri;
      } else {
        const next = pending.shift();
        if (next === undefined) return { batches: [] };
        currentUri = this.contentUrl(scopeKey, next);
      }
    } else {
      const hasSince = opts.since !== undefined;
      const hasUntil = opts.until !== undefined;
      if (hasSince !== hasUntil) {
        throw new AuditConfigError(
          'Management Activity API requires both since and until, or neither',
        );
      }
      if (hasSince && hasUntil) {
        const windows = this.splitWindows(opts.since as string, opts.until as string);
        const first = windows.shift();
        if (first === undefined) return { batches: [] };
        pending = windows;
        currentUri = this.contentUrl(scopeKey, first);
      } else {
        pending = [];
        currentUri = this.contentUrl(scopeKey);
      }
    }

    const listRes = await ensureOk(await this.request(currentUri, 'GET'), 'fetchAuditPage(content)');
    const nextPageUri = listRes.headers.get('NextPageUri') ?? undefined;
    const list = contentListSchema.parse(JSON.parse(await listRes.text()));

    const batches: AuditBatch[] = [];
    for (const item of list) {
      const blobRes = await ensureOk(
        await this.request(item.contentUri, 'GET'),
        'fetchAuditPage(blob)',
      );
      const blobText = await blobRes.text();
      const rawBytes = new TextEncoder().encode(blobText);
      const elements = z.array(z.unknown()).parse(JSON.parse(blobText));
      const records = elements.map((el) => this.mapRecord(el));
      batches.push({
        system: 'o365_management_activity',
        batchId: item.contentId,
        scopeKey,
        rawBytes,
        contentType: 'application/json',
        records,
        providerReportedCount: records.length,
      });
    }

    let nextCursor: string | undefined;
    if (nextPageUri !== undefined) {
      nextCursor = encodeCursor({ pageUri: nextPageUri, pendingSubranges: pending });
    } else if (pending.length > 0) {
      nextCursor = encodeCursor({ pageUri: undefined, pendingSubranges: pending });
    }
    return { batches, nextCursor };
  }

  private mapRecord(element: unknown): AuditRecordRaw {
    const e = ualSchema.parse(element);
    return {
      system: 'o365_management_activity',
      providerRecordId: e.Id,
      workload: e.Workload,
      operation: e.Operation,
      recordType: e.RecordType !== undefined ? String(e.RecordType) : undefined,
      actorId: e.UserId,
      actorEmail: e.UserId,
      actorIp: e.ClientIP ?? e.ActorIpAddress ?? e.ClientIPAddress,
      targetId: e.ObjectId,
      resultStatus: e.ResultStatus,
      occurredAt: e.CreationTime,
      raw: element,
    };
  }
}
