import {
  DEFAULT_TIMEOUT_MS,
  ensureOk,
  providerFetch,
  type FetchLike,
  type ProviderFetchOptions,
} from '../http.js';
import type {
  DriveConnector,
  DriveContent,
  DriveEntry,
  DriveInfo,
  DriveListPage,
  FetchContentOptions,
  ListFilesOptions,
  RateLimitObserver,
  TokenProvider,
} from '../types.js';
import { dropboxApiArg } from './api-arg.js';
import { mapDropboxPage, type RawDropboxPage } from './entries.js';

const RPC_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

export interface DropboxDriveConnectorOptions {
  tokenProvider: TokenProvider;
  /**
   * Organization mode: collect as this Dropbox team member.
   *
   * Sent as `Dropbox-API-Select-User`. Omitted entirely in delegated mode —
   * sending it with a wrong or empty value would collect the wrong custodian,
   * which is the failure mode the forced account chooser exists to prevent.
   */
  selectUserId?: string;
  /** Override for tests. */
  rpcBase?: string;
  contentBase?: string;
  fetchImpl?: FetchLike;
  onRateLimit?: RateLimitObserver;
}

/**
 * Dropbox file collection, read-only.
 *
 * Two Dropbox-specific things shape this class:
 *
 *  - **One cursor does both jobs.** `list_folder` returns a cursor that
 *    continues the current walk AND, once the walk is done, becomes the resume
 *    point for later changes. So paging and incremental sync are the same call.
 *  - **Content endpoints put the request in a header.** See `dropboxApiArg`.
 */
export class DropboxDriveConnector implements DriveConnector {
  constructor(private readonly options: DropboxDriveConnectorOptions) {}

  private fetchOptions(): ProviderFetchOptions {
    return {
      tokenProvider: this.options.tokenProvider,
      provider: 'dropbox',
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      ...(this.options.onRateLimit === undefined ? {} : { onRateLimit: this.options.onRateLimit }),
    };
  }

  /** Headers every call shares. Select-User is only ever set in organization mode. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      ...(this.options.selectUserId === undefined
        ? {}
        : { 'Dropbox-API-Select-User': this.options.selectUserId }),
    };
  }

  private async rpc<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.options.rpcBase ?? RPC_BASE}${path}`;
    const response = await providerFetch(
      url,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
      this.fetchOptions(),
    );
    await ensureOk(response, `dropbox ${path}`);
    return (await response.json()) as T;
  }

  /**
   * Dropbox gives an account one namespace, so there is exactly one "drive".
   * Returned as a single entry so the rest of the pipeline, which was written
   * for providers that have many, needs no special case.
   */
  async listDrives(_custodian: string): Promise<DriveInfo[]> {
    return [{ id: 'dropbox', name: 'Dropbox', driveType: 'personal' }];
  }

  async listFiles(_custodian: string, opts: ListFilesOptions = {}): Promise<DriveListPage> {
    if (opts.cursor !== undefined && opts.cursor !== '') {
      const page = await this.rpc<RawDropboxPage>('/files/list_folder/continue', {
        cursor: opts.cursor,
      });
      return mapDropboxPage(page);
    }

    const page = await this.rpc<RawDropboxPage>('/files/list_folder', {
      // '' is the account root: Dropbox rejects '/' here, which is the obvious
      // guess and fails with a path error that reads like a permissions problem.
      path: opts.folderId === undefined || opts.folderId === '' ? '' : opts.folderId,
      recursive: true,
      // A deleted file is a finding, so the ledger should see it. The mapper
      // marks these trashed and not downloadable.
      include_deleted: opts.includeTrashed ?? false,
      include_media_info: false,
      include_mounted_folders: true,
      // Shared folders the custodian has mounted are theirs to answer for.
      include_non_downloadable_files: true,
    });
    return mapDropboxPage(page);
  }

  /**
   * Continue from a saved cursor.
   *
   * Identical call to paging, because in Dropbox it is the same cursor. Kept as
   * its own method so the pipeline's incremental path stays explicit.
   */
  async getChangesDelta(_custodian: string, deltaCursor?: string): Promise<DriveListPage> {
    if (deltaCursor === undefined || deltaCursor === '') {
      return this.listFiles(_custodian, {});
    }
    const page = await this.rpc<RawDropboxPage>('/files/list_folder/continue', {
      cursor: deltaCursor,
    });
    return mapDropboxPage(page);
  }

  async fetchContent(
    _custodian: string,
    entry: DriveEntry,
    _opts: FetchContentOptions = {},
  ): Promise<DriveContent> {
    // Address by id, not path: a custodian renaming a file mid-collection would
    // otherwise turn into a 409 or, worse, fetch a different file that has since
    // taken the path.
    const arg = dropboxApiArg({ path: entry.providerItemId });
    const url = `${this.options.contentBase ?? CONTENT_BASE}/files/download`;
    const response = await providerFetch(
      url,
      {
        method: 'POST',
        headers: this.headers({ 'Dropbox-API-Arg': arg }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
      this.fetchOptions(),
    );
    await ensureOk(response, `dropbox download ${entry.providerItemId}`);

    const body = response.body;
    return {
      stream: body ?? new Uint8Array(await response.arrayBuffer()),
      ...(entry.mimeType === '' ? {} : { contentType: entry.mimeType }),
      // These are the stored bytes, not a converted export. Dropbox has no
      // equivalent of Google's native-document export, so this is always false —
      // and saying so matters: an export derivative is not the original.
      apiExportDerivative: false,
    };
  }
}
