export { IntegrityError, KeyValidationError } from './errors.js';
export { Sha256Stream, hashBuffer, hashStreamToNull } from './hash.js';
export {
  assertKeyInTenant,
  derivativeKey,
  exportKey,
  keyClass,
  manifestKey,
  originalKey,
  productionKey,
  quarantineKey,
  sanitizeFilename,
  stagingKey,
} from './objectKeys.js';
export type { KeyClass } from './objectKeys.js';
export { canonicalJson } from './canonical.js';
export { merkleRoot, sortedMerkleRoot } from './merkle.js';
export {
  COMPLETENESS_VALUES,
  buildManifest,
  renderCompletenessReport,
  serializeManifest,
  signManifest,
  verifyManifestSignature,
} from './manifest.js';
export type {
  BuildManifestInput,
  CollectionManifestV1,
  Completeness,
  ManifestApplication,
  ManifestCollection,
  ManifestCounts,
  ManifestCustodian,
  ManifestException,
  ManifestItem,
  ManifestSignature,
  ProviderReportedTotal,
} from './manifest.js';
export { EvidenceObjectStore } from './store.js';
export type {
  BucketClass,
  BucketProtection,
  EvidenceObjectStoreOptions,
  PresignFn,
  PromoteResult,
  StageResult,
} from './store.js';

// ---------------------------------------------------------------------------
// Processing pipeline (src/processing/): MIME parsing, safe previews, text
// extraction (Tika), OCR (Tesseract), malware scanning (ClamAV), archive
// bomb guards, and parser version attribution.
// ---------------------------------------------------------------------------
export {
  ArchiveBombError,
  ArchiveDepthExceededError,
  EncryptedContentError,
  OcrError,
  TextExtractionTooLargeError,
  UnsupportedFormatError,
} from './processing/errors.js';
export { decodeEncodedWords, parseEmail } from './processing/mime.js';
export type {
  EmailParticipant,
  ParsedAttachment,
  ParsedEmail,
  ParticipantRole,
  RawHeader,
  SmimeType,
} from './processing/mime.js';
export { decodeEntities, htmlToText } from './processing/html-to-text.js';
export {
  buildSafeEmailPreview,
  buildTextPreview,
  filterStyleAttribute,
} from './processing/safe-preview.js';
export type {
  SafeEmailPreview,
  SafeEmailPreviewOptions,
} from './processing/safe-preview.js';
export { TikaClient } from './processing/tika-client.js';
export type { TikaClientOptions } from './processing/tika-client.js';
export { TesseractOcr, parseTsv, rasterizePdf, spawnRunner } from './processing/ocr.js';
export type {
  OcrResult,
  OcrWord,
  ProcessRunner,
  RasterizeOptions,
  RasterizeResult,
  RunnerResult,
  TesseractOcrOptions,
} from './processing/ocr.js';
export {
  ClamAvScanner,
  parseScanResponse,
  parseVersionResponse,
} from './processing/clamav.js';
export type {
  ClamAvScannerOptions,
  ClamVersion,
  ScanResult,
  ScanStatus,
} from './processing/clamav.js';
export { ExpansionGuard, gunzipCapped } from './processing/limits.js';
export type { ArchiveScope, ExpansionGuardOptions } from './processing/limits.js';
export {
  PARSER_VERSIONS,
  collectParserVersions,
} from './processing/pipeline-versions.js';
export type { CollectParserVersionsInput } from './processing/pipeline-versions.js';
