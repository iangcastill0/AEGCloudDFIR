/**
 * The canonical shape of an evidence item as stored in the search index.
 * This is the only document shape the search package indexes or returns.
 */

export type EvidenceKind = 'email' | 'attachment' | 'file' | 'audit_record' | 'audit_batch';

/** Structured fields for an audit-log event (contract §5 audit sources). */
export interface EvidenceAuditFields {
  /** o365_management_activity | graph_directory_audits | graph_signins | google_reports | google_vault */
  system: string;
  /** Exchange, SharePoint, AzureActiveDirectory, Teams, login, drive, admin, ... */
  workload?: string;
  operation?: string;
  recordType?: string;
  actorId?: string;
  actorEmail?: string;
  actorIp?: string;
  targetId?: string;
  targetType?: string;
  resultStatus?: string;
  /** Event time reported by the provider (ISO UTC). */
  occurredAt?: string;
}

export interface EmailAddress {
  /** Display name, when present in the source. */
  name?: string;
  /** Full address, normalized to lowercase. */
  address: string;
  /** Domain portion of the address, normalized to lowercase. */
  domain: string;
}

export interface EvidenceDates {
  sent?: string;
  received?: string;
  created?: string;
  modified?: string;
  acquired?: string;
  /** The single "best" date used for default sorting and `date:` queries. */
  primary?: string;
}

export interface EvidenceEmailFields {
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  from?: EmailAddress[];
  sender?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  /** Only populated when BCC data is genuinely present in the source. */
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  /** True when the source indicated BCC recipients existed (even if unknown). */
  bccPresent: boolean;
}

export interface RawHeader {
  /** Header name, matched case-insensitively at query time. */
  name: string;
  value: string;
}

export interface OcrPage {
  page: number;
  text: string;
  confidence?: number;
}

export interface EvidenceTag {
  id: string;
  name: string;
  privileged: boolean;
  confidential: boolean;
}

export interface BatesRecord {
  productionId: string;
  productionName: string;
  begBates: string;
  endBates: string;
}

export interface EvidenceSearchDoc {
  evidenceItemId: string;
  tenantId: string;
  kind: EvidenceKind;
  /** Filename or subject-derived display name. */
  name: string;
  extension?: string;
  mimeType?: string;
  /** Size in bytes. */
  size?: number;
  sha256?: string;
  custodianId?: string;
  custodianEmail?: string;
  provider?: string;
  connectorAccountId?: string;
  collectionId?: string;
  sourcePath?: string;
  sourceLabels?: string[];
  folder?: string;
  dates: EvidenceDates;
  email?: EvidenceEmailFields;
  /** Present for audit_record / audit_batch evidence. */
  audit?: EvidenceAuditFields;
  /** All raw headers, searchable as key/value pairs. */
  headers?: RawHeader[];
  /** Normalized participant addresses and domains across all address fields. */
  addresses?: {
    all: string[];
    domains: string[];
  };
  text?: {
    body?: string;
    /** Plain text extracted from the HTML body. */
    bodyHtml?: string;
    attachment?: string;
    file?: string;
    ocr?: string;
  };
  ocrPages?: OcrPage[];
  tags?: EvidenceTag[];
  /** Denormalized tag names for fast term filtering and facets. */
  tagNames?: string[];
  caseIds?: string[];
  privileged: boolean;
  confidential: boolean;
  processingStatus?: string;
  malwareStatus?: string;
  familyId?: string;
  parentId?: string;
  isFamilyChild?: boolean;
  bates?: BatesRecord[];
  hasBeenProduced: boolean;
  /** ISO timestamp of when this doc was (re)indexed. */
  indexedAt: string;
  /** Mapping/document schema version this doc was written with. */
  docVersion: number;
}
