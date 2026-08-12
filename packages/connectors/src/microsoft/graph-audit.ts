/**
 * Microsoft Graph audit-log connector (READ-ONLY) for two scopes:
 *   - 'directoryAudits' → /auditLogs/directoryAudits
 *   - 'signIns'         → /auditLogs/signIns
 *
 * App token scope: https://graph.microsoft.com/.default (AuditLog.Read.All).
 *
 * Each provider page becomes ONE AuditBatch: rawBytes = the untouched page
 * JSON, records = value[] mapped to AuditRecordRaw. Paging follows
 * @odata.nextLink, carried opaquely as the cursor.
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
  type AuditSystem,
  type FetchAuditPageOptions,
  type RateLimitObserver,
  type TokenProvider,
} from '../types.js';
import { normalizeBaseUrl } from './common.js';

export type GraphAuditScope = 'directoryAudits' | 'signIns';

export const GRAPH_AUDIT_SCOPES: readonly GraphAuditScope[] = ['directoryAudits', 'signIns'];

export interface GraphAuditOptions {
  tokenProvider: TokenProvider;
  /** e.g. https://graph.microsoft.com/v1.0 (override for the fake server). */
  graphBaseUrl: string;
  /** The audit scopes enabled for this connection (defaults to both). */
  scopes?: readonly GraphAuditScope[];
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

const pageSchema = z.object({
  value: z.array(z.unknown()).default([]),
  '@odata.nextLink': z.string().optional(),
});

const directoryAuditSchema = z.object({
  id: z.string(),
  activityDisplayName: z.string().optional(),
  category: z.string().optional(),
  activityDateTime: z.string().optional(),
  result: z.string().optional(),
  initiatedBy: z
    .object({
      user: z
        .object({ id: z.string().optional(), userPrincipalName: z.string().optional() })
        .optional(),
      app: z.object({ displayName: z.string().optional() }).optional(),
    })
    .optional(),
  targetResources: z
    .array(z.object({ id: z.string().optional(), type: z.string().optional() }))
    .optional(),
});

const signInSchema = z.object({
  id: z.string(),
  activityDisplayName: z.string().optional(),
  appDisplayName: z.string().optional(),
  createdDateTime: z.string().optional(),
  userPrincipalName: z.string().optional(),
  userId: z.string().optional(),
  ipAddress: z.string().optional(),
  resourceDisplayName: z.string().optional(),
  status: z
    .object({ errorCode: z.number().optional(), failureReason: z.string().optional() })
    .optional(),
});

interface ScopeConfig {
  resource: string;
  dateField: string;
  system: AuditSystem;
}

const SCOPE_CONFIG: Record<GraphAuditScope, ScopeConfig> = {
  directoryAudits: {
    resource: 'directoryAudits',
    dateField: 'activityDateTime',
    system: 'graph_directory_audits',
  },
  signIns: {
    resource: 'signIns',
    dateField: 'createdDateTime',
    system: 'graph_signins',
  },
};

function isGraphAuditScope(value: string): value is GraphAuditScope {
  return value === 'directoryAudits' || value === 'signIns';
}

/** Pull $skiptoken from a nextLink for a stable, log-safe batch id. */
function skipToken(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('$skiptoken') ?? undefined;
  } catch {
    return undefined;
  }
}

export class GraphAuditConnector implements AuditConnector {
  private readonly base: string;
  private readonly scopes: readonly GraphAuditScope[];
  private readonly options: GraphAuditOptions;

  constructor(options: GraphAuditOptions) {
    this.options = options;
    this.base = normalizeBaseUrl(options.graphBaseUrl);
    this.scopes = options.scopes ?? GRAPH_AUDIT_SCOPES;
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

  private get(url: string): Promise<Response> {
    return providerFetch(url, { method: 'GET' }, this.fetchOptions());
  }

  listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    return Promise.resolve(this.scopes.map((s) => ({ scopeKey: s, label: s })));
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    if (!isGraphAuditScope(scopeKey)) {
      throw new Error(`unknown Graph audit scope: ${scopeKey}`);
    }
    const config = SCOPE_CONFIG[scopeKey];

    let url: string;
    if (opts.cursor !== undefined) {
      url = opts.cursor;
    } else {
      const u = new URL(`${this.base}/auditLogs/${config.resource}`);
      const filters: string[] = [];
      if (opts.since !== undefined) filters.push(`${config.dateField} ge ${opts.since}`);
      if (opts.until !== undefined) filters.push(`${config.dateField} le ${opts.until}`);
      if (filters.length > 0) u.searchParams.set('$filter', filters.join(' and '));
      u.searchParams.set('$top', '100');
      url = u.toString();
    }

    const res = await ensureOk(await this.get(url), 'fetchAuditPage');
    const text = await res.text();
    const page = pageSchema.parse(JSON.parse(text));
    const rawBytes = new TextEncoder().encode(text);

    const records = page.value.map((el) =>
      scopeKey === 'directoryAudits'
        ? this.mapDirectoryAudit(el)
        : this.mapSignIn(el),
    );

    const batch: AuditBatch = {
      system: config.system,
      batchId: `${scopeKey}:${skipToken(url) ?? 'initial'}`,
      scopeKey,
      rawBytes,
      contentType: 'application/json',
      records,
      providerReportedCount: records.length,
    };

    return { batches: [batch], nextCursor: page['@odata.nextLink'] };
  }

  private mapDirectoryAudit(element: unknown): AuditRecordRaw {
    const e = directoryAuditSchema.parse(element);
    const target = e.targetResources?.[0];
    return {
      system: 'graph_directory_audits',
      providerRecordId: e.id,
      operation: e.activityDisplayName,
      workload: e.category,
      actorEmail: e.initiatedBy?.user?.userPrincipalName,
      actorId: e.initiatedBy?.user?.id,
      targetId: target?.id,
      targetType: target?.type,
      resultStatus: e.result,
      occurredAt: e.activityDateTime,
      raw: element,
    };
  }

  private mapSignIn(element: unknown): AuditRecordRaw {
    const e = signInSchema.parse(element);
    let resultStatus: string | undefined;
    if (e.status?.errorCode !== undefined) {
      resultStatus =
        e.status.errorCode === 0 ? 'success' : (e.status.failureReason ?? String(e.status.errorCode));
    }
    return {
      system: 'graph_signins',
      providerRecordId: e.id,
      operation: e.activityDisplayName ?? e.appDisplayName,
      workload: e.resourceDisplayName,
      actorEmail: e.userPrincipalName,
      actorId: e.userId,
      actorIp: e.ipAddress,
      resultStatus,
      occurredAt: e.createdDateTime,
      raw: element,
    };
  }
}
