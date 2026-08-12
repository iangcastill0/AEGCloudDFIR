/**
 * Google Vault connector (READ-ONLY). Enumerates existing matters and their
 * COMPLETED exports. It NEVER creates matters, holds, or exports — creating an
 * export is a write and is deliberately out of scope.
 *
 * DWD scope: ediscovery.readonly, via a service-account token source
 * impersonating a Vault admin (the token source enforces the domain allowlist).
 *
 * METADATA-ONLY: a completed export becomes an AuditBatch whose rawBytes are
 * the export DESCRIPTOR JSON, not the export archive bytes. The archive lives
 * in a Cloud Storage sink and requires storage.objects.get on the sink bucket;
 * downloading it is a documented follow-up (see the note on the export record).
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
  type FetchAuditPageOptions,
  type RateLimitObserver,
  type TokenProvider,
} from '../types.js';
import { normalizeBaseUrl } from './common.js';

const DEFAULT_VAULT_BASE_URL = 'https://vault.googleapis.com';

export interface GoogleVaultOptions {
  tokenProvider: TokenProvider;
  /** Defaults to https://vault.googleapis.com (override for the fake server). */
  vaultBaseUrl?: string;
  /** When set, only these matters are exposed as scopes. */
  vaultMatterIds?: readonly string[];
  onRateLimit?: RateLimitObserver;
  fetchImpl?: FetchLike;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
}

const matterSchema = z.object({
  matterId: z.string(),
  name: z.string().optional(),
  state: z.string().optional(),
});

const mattersPageSchema = z.object({
  matters: z.array(matterSchema).default([]),
  nextPageToken: z.string().optional(),
});

const exportSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  matterId: z.string().optional(),
  status: z.string().optional(),
  createTime: z.string().optional(),
});

const exportsPageSchema = z.object({
  // Keep the untouched element alongside typed fields so raw/rawBytes preserve
  // provider-only keys (e.g. cloudStorageSink) that the typed view drops.
  exports: z.array(z.unknown()).default([]),
  nextPageToken: z.string().optional(),
});

export class GoogleVaultConnector implements AuditConnector {
  private readonly base: string;
  private readonly options: GoogleVaultOptions;

  constructor(options: GoogleVaultOptions) {
    this.options = options;
    this.base = normalizeBaseUrl(options.vaultBaseUrl ?? DEFAULT_VAULT_BASE_URL);
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

  async listAuditScopes(): Promise<{ scopeKey: string; label: string }[]> {
    const allow = this.options.vaultMatterIds;
    const scopes: { scopeKey: string; label: string }[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(`${this.base}/v1/matters`);
      u.searchParams.set('state', 'OPEN');
      u.searchParams.set('pageSize', '100');
      if (pageToken !== undefined) u.searchParams.set('pageToken', pageToken);
      const res = await ensureOk(await this.get(u.toString()), 'listAuditScopes');
      const page = mattersPageSchema.parse(await res.json());
      for (const matter of page.matters) {
        if (allow !== undefined && !allow.includes(matter.matterId)) continue;
        scopes.push({ scopeKey: matter.matterId, label: matter.name ?? matter.matterId });
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return scopes;
  }

  async fetchAuditPage(scopeKey: string, opts: FetchAuditPageOptions): Promise<AuditListPage> {
    const u = new URL(`${this.base}/v1/matters/${encodeURIComponent(scopeKey)}/exports`);
    if (opts.cursor !== undefined) u.searchParams.set('pageToken', opts.cursor);
    const res = await ensureOk(await this.get(u.toString()), 'fetchAuditPage');
    const page = exportsPageSchema.parse(await res.json());

    const batches: AuditBatch[] = [];
    for (const element of page.exports) {
      const exp = exportSchema.parse(element);
      if (exp.status !== 'COMPLETED') continue; // in-progress/failed exports are skipped
      const descriptor = JSON.stringify(element);
      batches.push({
        system: 'google_vault',
        batchId: exp.id,
        scopeKey,
        // METADATA-ONLY: descriptor bytes, not the export archive from GCS.
        rawBytes: new TextEncoder().encode(descriptor),
        contentType: 'application/json',
        providerReportedCount: 1,
        records: [
          {
            system: 'google_vault',
            providerRecordId: exp.id,
            operation: 'vault_export',
            workload: 'vault',
            recordType: 'vault_export',
            occurredAt: exp.createTime,
            // Follow-up: the actual export archive must be downloaded from its
            // Cloud Storage sink (needs storage.objects.get on the sink bucket).
            raw: element,
          },
        ],
      });
    }

    return { batches, nextCursor: page.nextPageToken };
  }
}
