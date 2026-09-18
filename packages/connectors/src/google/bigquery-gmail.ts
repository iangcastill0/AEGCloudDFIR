/**
 * Gmail message events from the Google Workspace "logs and reports in BigQuery"
 * export (READ-ONLY), as an alternative/deeper source to the Admin SDK Reports
 * `gmail` application. BigQuery carries richer per-message detail (device/client
 * context, post-delivery actions) and up to ~6 months of historical view events
 * for exports enabled Aug 2024+, where the Reports API is capped at 180 days.
 *
 * !!! UNVERIFIED AGAINST REAL BIGQUERY !!!
 * This connector is exercised only with mocked BigQuery responses. The exact
 * Workspace-logs table name and the nested column paths used in GMAIL_QUERY
 * (event_info.mail_event_type, message_info.rfc2822_message_id, time_usec, ...)
 * must be confirmed against a real export on staging before relying on it. The
 * response-parsing and paging logic are schema-driven (it reads the returned
 * `schema.fields[].name`), so column-name drift shows up as empty fields rather
 * than a crash.
 *
 * Auth: a service-account bearer token with BigQuery read scope (see
 * BIGQUERY_READONLY_SCOPE). Query billing runs in the configured project.
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
import { GMAIL_MAIL_EVENT_TYPES } from './reports.js';

const DEFAULT_BIGQUERY_BASE_URL = 'https://bigquery.googleapis.com';

/** OAuth scope the service-account token must carry for read-only querying. */
export const BIGQUERY_READONLY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';

const DEFAULT_PAGE_SIZE = 1000;

export interface BigQueryGmailOptions {
  tokenProvider: TokenProvider;
  /** GCP project the query job runs (and is billed) in. */
  projectId: string;
  /** Dataset holding the Workspace logs export. */
  dataset: string;
  /** Table within the dataset (the Gmail/activity export table). */
  table: string;
  /** Defaults to https://bigquery.googleapis.com (override for the fake server). */
  bigQueryBaseUrl?: string;
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  pageSize?: number;
}

/**
 * The Gmail-events query. Column paths reflect the documented Workspace-logs
 * Gmail schema and are aliased flat so row parsing is trivial. Parameterized
 * (NAMED) to avoid any injection from the time bounds. VERIFY the table's actual
 * column paths on staging.
 */
function gmailQuery(fq: string): string {
  return [
    'SELECT',
    '  event_info.mail_event_type AS mail_event_type,',
    '  actor.email AS actor_email,',
    '  message_info.rfc2822_message_id AS message_id,',
    '  message_info.subject AS subject,',
    '  event_info.client_context.client_type AS client_type,',
    '  ip_address AS ip_address,',
    '  TIMESTAMP_MICROS(time_usec) AS event_time',
    `FROM \`${fq}\``,
    'WHERE event_info.mail_event_type IS NOT NULL',
    '  AND (@since IS NULL OR time_usec >= UNIX_MICROS(@since))',
    '  AND (@until IS NULL OR time_usec < UNIX_MICROS(@until))',
    'ORDER BY time_usec',
  ].join('\n');
}

/** BigQuery returns rows as positional `f[].v` against `schema.fields[].name`. */
const bqResponseSchema = z.object({
  jobReference: z
    .object({ jobId: z.string().optional(), location: z.string().optional() })
    .optional(),
  jobComplete: z.boolean().optional(),
  pageToken: z.string().optional(),
  totalRows: z.union([z.string(), z.number()]).optional(),
  schema: z.object({ fields: z.array(z.object({ name: z.string() })).default([]) }).optional(),
  rows: z.array(z.object({ f: z.array(z.object({ v: z.unknown() })).default([]) })).optional(),
});

interface BqCursor {
  jobId: string;
  pageToken: string;
  location?: string;
}
function encodeCursor(c: BqCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(value: string): BqCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { jobId?: unknown }).jobId === 'string' &&
      typeof (parsed as { pageToken?: unknown }).pageToken === 'string'
    ) {
      return parsed as BqCursor;
    }
  } catch {
    // not a BigQuery cursor
  }
  return undefined;
}

function cellString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export class BigQueryGmailConnector implements AuditConnector {
  private readonly base: string;
  private readonly options: BigQueryGmailOptions;

  constructor(options: BigQueryGmailOptions) {
    this.options = options;
    this.base = normalizeBaseUrl(options.bigQueryBaseUrl ?? DEFAULT_BIGQUERY_BASE_URL);
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
    };
  }

  private get fqTable(): string {
    return `${this.options.projectId}.${this.options.dataset}.${this.options.table}`;
  }

  listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    return Promise.resolve([
      { scopeKey: `${this.options.dataset}.${this.options.table}`, label: 'Gmail logs (BigQuery)' },
    ]);
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    const cursor = opts.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
    let res: Response;
    if (cursor !== undefined) {
      // Subsequent page: getQueryResults on the running job.
      const u = new URL(
        `${this.base}/bigquery/v2/projects/${encodeURIComponent(this.options.projectId)}/queries/${encodeURIComponent(cursor.jobId)}`,
      );
      u.searchParams.set('pageToken', cursor.pageToken);
      u.searchParams.set('maxResults', String(this.options.pageSize ?? DEFAULT_PAGE_SIZE));
      if (cursor.location !== undefined) u.searchParams.set('location', cursor.location);
      res = await ensureOk(
        await providerFetch(u.toString(), { method: 'GET' }, this.fetchOptions()),
        'bigquery.getQueryResults',
      );
    } else {
      // First page: submit the query job.
      const url = `${this.base}/bigquery/v2/projects/${encodeURIComponent(this.options.projectId)}/queries`;
      const body = {
        query: gmailQuery(this.fqTable),
        useLegacySql: false,
        maxResults: this.options.pageSize ?? DEFAULT_PAGE_SIZE,
        parameterMode: 'NAMED',
        queryParameters: [
          {
            name: 'since',
            parameterType: { type: 'TIMESTAMP' },
            parameterValue: { value: opts.since ?? null },
          },
          {
            name: 'until',
            parameterType: { type: 'TIMESTAMP' },
            parameterValue: { value: opts.until ?? null },
          },
        ],
      };
      res = await ensureOk(
        await providerFetch(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          this.fetchOptions(),
        ),
        'bigquery.query',
      );
    }

    const text = await res.text();
    const parsedJson: unknown = JSON.parse(text);
    const page = bqResponseSchema.parse(parsedJson);
    const rawBytes = new TextEncoder().encode(text);

    const fieldNames = (page.schema?.fields ?? []).map((f) => f.name);
    const col = (row: { f: { v: unknown }[] }, name: string): unknown => {
      const idx = fieldNames.indexOf(name);
      return idx >= 0 ? row.f[idx]?.v : undefined;
    };

    const records: AuditRecordRaw[] = (page.rows ?? []).map((row, rowIndex) => {
      const mailType = cellString(col(row, 'mail_event_type'));
      const messageId = cellString(col(row, 'message_id'));
      const eventTime = cellString(col(row, 'event_time'));
      const operation =
        mailType !== undefined
          ? (GMAIL_MAIL_EVENT_TYPES[mailType] ?? `mail_event_type ${mailType}`)
          : 'gmail_event';
      return {
        system: 'google_bigquery_gmail',
        providerRecordId: `${messageId ?? 'na'}:${mailType ?? 'na'}:${eventTime ?? String(rowIndex)}`,
        operation,
        recordType: mailType !== undefined ? `gmail_mail_event:${mailType}` : 'gmail_event',
        workload: 'gmail',
        actorEmail: cellString(col(row, 'actor_email')),
        actorIp: cellString(col(row, 'ip_address')),
        ...(messageId !== undefined ? { targetId: messageId } : {}),
        occurredAt: eventTime,
        raw: Object.fromEntries(fieldNames.map((n) => [n, col(row, n)])),
      };
    });

    const jobId = cursor?.jobId ?? page.jobReference?.jobId;
    const location = cursor?.location ?? page.jobReference?.location;
    const nextCursor =
      page.pageToken !== undefined && jobId !== undefined
        ? encodeCursor({ jobId, pageToken: page.pageToken, ...(location ? { location } : {}) })
        : undefined;

    const batch: AuditBatch = {
      system: 'google_bigquery_gmail',
      batchId: `${scopeKey}:${opts.cursor ?? 'initial'}`,
      scopeKey,
      rawBytes,
      contentType: 'application/json',
      records,
      ...(page.totalRows !== undefined ? { providerReportedCount: Number(page.totalRows) } : {}),
    };

    return { batches: [batch], nextCursor };
  }
}
