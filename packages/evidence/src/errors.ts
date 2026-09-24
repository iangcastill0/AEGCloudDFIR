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

/**
 * True when an S3 request failed because the object is not there.
 *
 * This is the difference between "the scanner is down" and "the evidence is
 * gone", and the caller cannot tell them apart without it. Matched on the SDK's
 * own typed signals — `err.name` and the HTTP status in `$metadata` — never on
 * the message text. The wording is the provider's to change: Wasabi answers
 * "The specified key does not exist." today, and a string match would stop
 * working the day that sentence is reworded, silently.
 *
 * GetObject answers `NoSuchKey`; HeadObject answers `NotFound`. Both mean the
 * key is absent. `AccessDenied` deliberately does NOT match: a credential that
 * lost its grant must never be reported as missing evidence.
 *
 * `NoSuchBucket` is excluded by name even though it is also a 404. A wrong
 * bucket name would otherwise make every object in the system look deleted.
 */
export function isObjectNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === 'NoSuchBucket') return false;
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  return e.$metadata?.httpStatusCode === 404;
}
