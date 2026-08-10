/**
 * Error thrown when object bytes on storage do not match what the caller
 * asserted (size or SHA-256 mismatch during staging → verify → promote).
 */
export class IntegrityError extends Error {
  override readonly name = 'IntegrityError';

  constructor(
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

/**
 * Error thrown when an object key fails validation (wrong tenant prefix,
 * path traversal characters, malformed identifiers, ...).
 *
 * Extends TypeError so callers that only catch TypeError still see
 * key-validation failures as programming errors.
 */
export class KeyValidationError extends TypeError {
  override readonly name = 'KeyValidationError';

  constructor(message: string) {
    super(message);
  }
}
