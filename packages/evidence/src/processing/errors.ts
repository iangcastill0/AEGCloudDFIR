/**
 * Processing-pipeline error types.
 *
 * These errors are thrown by the pure processing helpers (MIME parsing,
 * text extraction, OCR, archive expansion) and are translated by the worker
 * into recorded processing exceptions on the evidence item. None of them is
 * ever "handled" by retrying with guessed passwords or by fetching remote
 * resources — encrypted content is recorded as an exception, never brute
 * forced.
 */

/**
 * Content is password protected or encrypted (S/MIME, PGP, encrypted PDF or
 * Office document, encrypted archive entry). Callers must record a
 * processing exception; brute forcing is never attempted.
 */
export class EncryptedContentError extends Error {
  override readonly name = 'EncryptedContentError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/** Extraction service reported the format as unsupported or corrupt. */
export class UnsupportedFormatError extends Error {
  override readonly name = 'UnsupportedFormatError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/** Extracted text exceeded the configured hard cap and was aborted. */
export class TextExtractionTooLargeError extends Error {
  override readonly name = 'TextExtractionTooLargeError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/**
 * Decompression output exceeded the configured expansion limits
 * (CDFIR_MAX_ARCHIVE_EXPANSION_RATIO / CDFIR_MAX_ARCHIVE_TOTAL_BYTES).
 */
export class ArchiveBombError extends Error {
  override readonly name = 'ArchiveBombError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/** Nested archive depth exceeded the configured limit (CDFIR_MAX_ARCHIVE_DEPTH). */
export class ArchiveDepthExceededError extends Error {
  override readonly name = 'ArchiveDepthExceededError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/** OCR engine invocation failed (non-zero exit, unparsable output, ...). */
export class OcrError extends Error {
  override readonly name = 'OcrError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}
