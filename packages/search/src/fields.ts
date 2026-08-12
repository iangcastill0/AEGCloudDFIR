/**
 * Field registry: the only bridge between user-facing query field names and
 * OpenSearch document paths. A field that is not in this registry cannot be
 * queried — in particular `tenantId`, `caseIds`, `privileged`, etc. as raw
 * document paths are NOT queryable; tenancy and ACL constraints are injected
 * exclusively by `wrapWithAuthorization`.
 */

import { QueryValidationError } from './errors.js';

export type FieldType =
  'text' | 'keyword' | 'date' | 'size' | 'address' | 'header' | 'ocr' | 'boolean';

export interface FieldDef {
  esPath: string;
  type: FieldType;
}

export interface ResolvedField extends FieldDef {
  /** Canonical registry name (lowercased user field name). */
  name: string;
  /** For `header.<name>` fields: the lowercased raw header name to match. */
  headerName?: string;
}

/** Sentinel esPath meaning "all searchable text fields". */
export const ALL_TEXT_PATH = '*';

/** Concrete document paths that make up the default/all-text search surface. */
export const ALL_TEXT_FIELDS: readonly string[] = [
  'text.body',
  'text.bodyHtml',
  'text.attachment',
  'text.file',
  'text.ocr',
  'name',
  'email.subject',
];

const FIELD_DEFS: Record<string, FieldDef> = {
  from: { esPath: 'email.from', type: 'address' },
  to: { esPath: 'email.to', type: 'address' },
  cc: { esPath: 'email.cc', type: 'address' },
  bcc: { esPath: 'email.bcc', type: 'address' },
  sender: { esPath: 'email.sender', type: 'address' },
  replyto: { esPath: 'email.replyTo', type: 'address' },
  participants: { esPath: 'addresses', type: 'address' },
  subject: { esPath: 'email.subject', type: 'text' },
  body: { esPath: 'text.body', type: 'text' },
  text: { esPath: ALL_TEXT_PATH, type: 'text' },
  attachment: { esPath: 'text.attachment', type: 'text' },
  ocr: { esPath: 'text.ocr', type: 'ocr' },
  filename: { esPath: 'name', type: 'text' },
  name: { esPath: 'name', type: 'text' },
  extension: { esPath: 'extension', type: 'keyword' },
  ext: { esPath: 'extension', type: 'keyword' },
  mime: { esPath: 'mimeType', type: 'keyword' },
  mimetype: { esPath: 'mimeType', type: 'keyword' },
  path: { esPath: 'sourcePath', type: 'keyword' },
  folder: { esPath: 'folder', type: 'keyword' },
  label: { esPath: 'sourceLabels', type: 'keyword' },
  labels: { esPath: 'sourceLabels', type: 'keyword' },
  source: { esPath: 'sourcePath', type: 'keyword' },
  hash: { esPath: 'sha256', type: 'keyword' },
  sha256: { esPath: 'sha256', type: 'keyword' },
  custodian: { esPath: 'custodianEmail', type: 'keyword' },
  provider: { esPath: 'provider', type: 'keyword' },
  tag: { esPath: 'tagNames', type: 'keyword' },
  tags: { esPath: 'tagNames', type: 'keyword' },
  case: { esPath: 'caseIds', type: 'keyword' },
  messageid: { esPath: 'email.messageId', type: 'keyword' },
  threadid: { esPath: 'email.threadId', type: 'keyword' },
  bates: { esPath: 'bates', type: 'keyword' },
  privileged: { esPath: 'privileged', type: 'boolean' },
  confidential: { esPath: 'confidential', type: 'boolean' },
  produced: { esPath: 'hasBeenProduced', type: 'boolean' },
  size: { esPath: 'size', type: 'size' },
  sent: { esPath: 'dates.sent', type: 'date' },
  received: { esPath: 'dates.received', type: 'date' },
  created: { esPath: 'dates.created', type: 'date' },
  modified: { esPath: 'dates.modified', type: 'date' },
  acquired: { esPath: 'dates.acquired', type: 'date' },
  date: { esPath: 'dates.primary', type: 'date' },
  // --- audit-log fields ---
  auditsystem: { esPath: 'audit.system', type: 'keyword' },
  workload: { esPath: 'audit.workload', type: 'keyword' },
  operation: { esPath: 'audit.operation', type: 'keyword' },
  recordtype: { esPath: 'audit.recordType', type: 'keyword' },
  actor: { esPath: 'audit.actorEmail', type: 'keyword' },
  actorip: { esPath: 'audit.actorIp', type: 'keyword' },
  auditresult: { esPath: 'audit.resultStatus', type: 'keyword' },
  audittarget: { esPath: 'audit.targetId', type: 'keyword' },
  occurred: { esPath: 'audit.occurredAt', type: 'date' },
};

/** Fields whose values are content hashes and must be normalized/validated. */
export const HASH_FIELD_NAMES: ReadonlySet<string> = new Set(['hash', 'sha256']);

export class FieldRegistry {
  private readonly defs: Record<string, FieldDef>;

  constructor(defs: Record<string, FieldDef> = FIELD_DEFS) {
    this.defs = defs;
  }

  allowedFields(): string[] {
    return [...Object.keys(this.defs), 'header.<name>'].sort();
  }

  /**
   * Resolve a user-facing field name to a registry entry.
   * Throws QueryValidationError listing allowed fields for unknown names.
   */
  resolve(field: string): ResolvedField {
    const normalized = field.toLowerCase();

    if (normalized.startsWith('header.')) {
      const headerName = normalized.slice('header.'.length);
      if (headerName.length === 0) {
        throw new QueryValidationError([
          `Invalid field "${field}": header fields must be written as header.<name>, e.g. header.x-originating-ip`,
        ]);
      }
      return { name: normalized, esPath: 'headers', type: 'header', headerName };
    }

    const def = this.defs[normalized];
    if (!def) {
      throw new QueryValidationError([
        `Unknown field "${field}". Allowed fields: ${this.allowedFields().join(', ')}`,
      ]);
    }
    return { name: normalized, ...def };
  }
}

export const DEFAULT_FIELD_REGISTRY = new FieldRegistry();

/** The implicit field used when a term has no `field:` prefix (all text). */
export const DEFAULT_TEXT_FIELD: ResolvedField = {
  name: 'text',
  esPath: ALL_TEXT_PATH,
  type: 'text',
};
