/**
 * Local production vocabulary.
 *
 * NOTE: these types intentionally mirror packages/contracts/src/productions.ts
 * (stamp positions, bates config, validation flag codes, output modes) but are
 * defined locally — this package must not depend on other workspace packages.
 */

export type StampPosition =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

export type StampKind = 'bates' | 'tag' | 'confidentiality' | 'custom';

export interface StampConfig {
  position: StampPosition;
  kind: StampKind;
  /** Fixed text for tag/confidentiality/custom stamps; ignored for bates. */
  text: string;
  /** 1..10 — on a position collision the higher priority stamp wins. */
  priority: number;
  /** When > 0, the page is enlarged on the stamped edge so stamps never cover content. */
  addedMarginPoints: number;
}

export interface BatesConfig {
  prefix: string;
  digits: number;
  suffix: string;
  numbering: 'per_page' | 'per_document';
}

export type PdfGrouping = 'per_page' | 'per_document' | 'per_family' | 'bulk';

export type ProductionImageFormat = 'tiff_g4' | 'jpeg' | 'pdf' | 'none';

export type LoadFileFormat = 'dat' | 'opt' | 'csv';

export type ProductionOutputMode =
  | { mode: 'natives_only' }
  | { mode: 'pdf_only'; pdfGrouping: PdfGrouping }
  | {
      mode: 'load_file';
      imageFormat: ProductionImageFormat;
      includeNatives: boolean;
      includeText: boolean;
      loadFileFormats: LoadFileFormat[];
    };

export type ProductionSortKey =
  | 'folder_filename'
  | 'filename'
  | 'primary_date_asc'
  | 'primary_date_desc'
  | 'custodian'
  | 'evidence_id';

export type FilenameScheme = 'bates' | 'original' | 'bates_original';

export type RedactionStage = 'preview' | 'final';

export type ValidationFlagCode =
  | 'redacted_native_leak'
  | 'redacted_ancestor_native_leak'
  | 'privileged_item'
  | 'privileged_descendant_container'
  | 'archive_container'
  | 'duplicate_item'
  | 'malware_item'
  | 'missing_native'
  | 'unsupported_conversion'
  | 'unprocessed_item'
  | 'encrypted_file'
  | 'missing_text'
  | 'duplicate_bates_range'
  | 'zero_byte_item'
  | 'corrupt_item'
  | 'family_split'
  | 'preview_redactions_in_release'
  | 'selection_changed_since_draft';

export type ValidationSeverity = 'info' | 'warning' | 'blocking' | 'security_critical';

export interface ValidationFlag {
  code: ValidationFlagCode;
  severity: ValidationSeverity;
  message: string;
  evidenceItemIds: string[];
  overridable: boolean;
  /** security_critical flags additionally require elevated permission + second confirmation. */
  requiresElevatedOverride: boolean;
}

/**
 * The flattened, persistence-agnostic record for one produced document.
 * Load file builders and the manifest consume this shape; the worker maps
 * database rows into it.
 */
export interface ProducedItemRecord {
  begBates: string;
  endBates: string;
  begAttach: string | null;
  endAttach: string | null;
  custodian: string | null;
  sourcePath: string | null;
  fileName: string | null;
  extension: string | null;
  mime: string | null;
  sha256: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  sentDate: string | null;
  receivedDate: string | null;
  dateCreated: string | null;
  dateModified: string | null;
  textPath: string | null;
  nativePath: string | null;
  tags: string[];
}
