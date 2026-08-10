/**
 * Connector SPI shared by the Microsoft and Google providers.
 *
 * This package is pure provider-API logic: persistence, encryption and
 * scheduling are done by callers through these interfaces. The string-literal
 * vocabularies below intentionally mirror the platform database enums
 * (Provider, ConnectionMode, ExceptionKind) without importing that package.
 */

export type ProviderName = 'microsoft' | 'google';

export type ConnectionMode = 'delegated' | 'organization';

export type ExceptionKind =
  | 'unavailable_item'
  | 'unsupported_item'
  | 'non_downloadable'
  | 'encrypted_item'
  | 'rights_managed'
  | 'corrupt_item'
  | 'throttled_skip'
  | 'expired_checkpoint'
  | 'permission_denied'
  | 'api_error';

/**
 * Supplies bearer tokens for provider API calls. Callers wire refresh-token
 * storage; implementations in oauth.ts cache access tokens in memory only.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Drop any cached access token (e.g. after a 401). */
  invalidate(): void;
}

export interface DiscoveredMailFolder {
  id: string;
  displayName: string;
  parentId?: string;
  /** Provider well-known folder name (e.g. 'deleteditems', 'recoverableitemsdeletions', Gmail system label id). */
  wellKnown?: string;
  totalItemCount?: number;
  /** Materialized path, e.g. '/Inbox/Projects'. */
  path: string;
}

/** Folder discovery result: partial failures are reported, never silently dropped. */
export interface MailFolderDiscovery {
  folders: DiscoveredMailFolder[];
  exceptions: ConnectorException[];
}

export interface EmailListEntry {
  providerItemId: string;
  providerImmutableId?: string;
  folderId?: string;
  labelIds?: string[];
  threadId?: string;
  receivedAt?: string;
  hasAttachments?: boolean;
  deleted?: boolean;
}

export interface EmailListPage {
  items: EmailListEntry[];
  /** Opaque cursor for the next page of the same listing. */
  nextCursor?: string;
  /** Opaque checkpoint for incremental sync (delta link / historyId). */
  deltaCursor?: string;
}

export interface EmailAddressRef {
  name?: string;
  address?: string;
}

export interface EmailAttachmentMeta {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  /** Content-ID for inline parts, preserved for HTML body reconstruction. */
  contentId?: string;
}

/**
 * API-level message metadata preserved alongside the RFC822 native.
 * bccRecipients is present ONLY when the provider API actually returned it.
 */
export interface EmailApiMetadata {
  subject?: string;
  from?: EmailAddressRef;
  sender?: EmailAddressRef;
  toRecipients?: EmailAddressRef[];
  ccRecipients?: EmailAddressRef[];
  bccRecipients?: EmailAddressRef[];
  replyTo?: EmailAddressRef[];
  sentAt?: string;
  receivedAt?: string;
  categories?: string[];
  flags?: Record<string, unknown>;
  isRead?: boolean;
  conversationId?: string;
  threadId?: string;
  labelIds?: string[];
  folderId?: string;
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  bodyContentType?: string;
  hasAttachments?: boolean;
  attachments?: EmailAttachmentMeta[];
  /** Gmail mailbox historyId observed when the message was fetched. */
  historyId?: string;
}

export interface FetchedEmail {
  providerItemId: string;
  /** Full RFC822 MIME bytes exactly as returned by the provider. */
  rfc822: Uint8Array;
  metadata: EmailApiMetadata;
}

export interface DriveInfo {
  id: string;
  name: string;
  driveType?: string;
}

export interface DriveEntry {
  providerItemId: string;
  name: string;
  mimeType: string;
  size?: number;
  /** Materialized path, e.g. '/Reports/q3.docx'. */
  path: string;
  parentId?: string;
  /** Provider-supplied checksums (quickXorHash, sha256, md5). Metadata only, never authoritative. */
  checksums: Record<string, string>;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  trashed?: boolean;
  sharedSummary?: unknown;
  driveId?: string;
  isFolder: boolean;
  downloadable: boolean;
  /** Set for Google-native types (application/vnd.google-apps.*). */
  googleNativeType?: string;
  versionId?: string;
}

export interface DriveListPage {
  items: DriveEntry[];
  nextCursor?: string;
  deltaCursor?: string;
}

export interface DriveContent {
  stream: ReadableStream<Uint8Array> | Uint8Array;
  contentType?: string;
  /** True when the bytes are an API export of a provider-native document, not the stored native. */
  apiExportDerivative: boolean;
  /** Export file extension (e.g. 'pdf', 'docx') when apiExportDerivative. */
  exportFormat?: string;
  /** Original provider-native MIME type when apiExportDerivative. */
  sourceNativeMimeType?: string;
}

/** A per-item collection exception record; callers persist these. */
export interface ConnectorException {
  kind: ExceptionKind;
  providerItemId?: string;
  message: string;
}

export interface ListMessagesOptions {
  /** ISO-8601 lower bound (inclusive) on received date. */
  since?: string;
  /** ISO-8601 upper bound (inclusive) on received date. */
  until?: string;
  cursor?: string;
  /** Include spam/trash (Gmail) when true. Graph deleted items are folders. */
  includeDeleted?: boolean;
}

export interface EmailConnector {
  /** custodianExternalId, or 'me' in delegated mode. */
  listMailFolders(custodian: string): Promise<MailFolderDiscovery>;
  listMessages(
    custodian: string,
    folderIdOrLabel: string,
    opts?: ListMessagesOptions,
  ): Promise<EmailListPage>;
  fetchMessage(custodian: string, providerItemId: string): Promise<FetchedEmail>;
  getMailDelta(custodian: string, folderId: string, deltaCursor?: string): Promise<EmailListPage>;
}

export interface ListFilesOptions {
  cursor?: string;
  driveId?: string;
  folderId?: string;
  includeTrashed?: boolean;
}

export interface FetchContentOptions {
  /** For Google-native exports: choose one of the configured export MIME types. */
  exportMimeType?: string;
}

export interface DriveConnector {
  listDrives(custodian: string): Promise<DriveInfo[]>;
  listFiles(custodian: string, opts?: ListFilesOptions): Promise<DriveListPage>;
  fetchContent(
    custodian: string,
    entry: DriveEntry,
    opts?: FetchContentOptions,
  ): Promise<DriveContent>;
  getChangesDelta(custodian: string, deltaCursor?: string): Promise<DriveListPage>;
}

export interface DirectoryUser {
  externalId: string;
  email: string;
  displayName: string;
}

export interface ListUsersOptions {
  search?: string;
  cursor?: string;
}

export interface DirectoryUserPage {
  users: DirectoryUser[];
  nextCursor?: string;
}

/** Org-mode custodian enumeration (Graph /users, Workspace Admin SDK). */
export interface CustodianDirectory {
  listUsers(opts?: ListUsersOptions): Promise<DirectoryUserPage>;
}

export type RateLimitObserver = (info: {
  provider: ProviderName;
  waitMs: number;
  reason: 'retry-after' | 'backoff';
  attempt: number;
}) => void;

// ---------------------------------------------------------------------------
// Typed errors. Messages are sanitized: they never contain header values,
// tokens, or query strings.
// ---------------------------------------------------------------------------

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProviderAuthError extends ConnectorError {
  readonly status?: number;
  readonly providerCode?: string;
  constructor(message: string, opts: { status?: number; providerCode?: string } = {}) {
    super(message);
    this.status = opts.status;
    this.providerCode = opts.providerCode;
  }
}

export class ProviderThrottledError extends ConnectorError {
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Gmail history checkpoint expired (users.history.list 404): caller must start a reconciliation scan and record it. */
export class HistoryExpiredError extends ConnectorError {}

/** Graph delta token expired (410 Gone): caller must restart a full enumeration. */
export class DeltaExpiredError extends ConnectorError {}

export class NonDownloadableError extends ConnectorError {
  readonly kind: ExceptionKind;
  readonly providerItemId?: string;
  constructor(
    message: string,
    opts: { kind?: ExceptionKind; providerItemId?: string } = {},
  ) {
    super(message);
    this.kind = opts.kind ?? 'non_downloadable';
    this.providerItemId = opts.providerItemId;
  }
}

export class DomainNotAllowedError extends ConnectorError {}

export class ProviderApiError extends ConnectorError {
  readonly status: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  constructor(
    message: string,
    opts: { status: number; providerCode?: string; requestId?: string },
  ) {
    super(message);
    this.status = opts.status;
    this.providerCode = opts.providerCode;
    this.requestId = opts.requestId;
  }
}
