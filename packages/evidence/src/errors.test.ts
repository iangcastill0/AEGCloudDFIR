import { describe, expect, it } from 'vitest';
import { isObjectNotFoundError } from './errors.js';

/** Shape the AWS SDK actually throws. */
function s3Error(name: string, httpStatusCode: number, message: string): Error {
  const err = new Error(message) as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = name;
  err.$metadata = { httpStatusCode };
  return err;
}

describe('isObjectNotFoundError', () => {
  it('matches NoSuchKey, which is what GetObject throws for an absent key', () => {
    expect(
      isObjectNotFoundError(s3Error('NoSuchKey', 404, 'The specified key does not exist.')),
    ).toBe(true);
  });

  it('matches NotFound, which is what HeadObject throws for the same thing', () => {
    expect(isObjectNotFoundError(s3Error('NotFound', 404, 'Not Found'))).toBe(true);
  });

  it('matches a 404 whose error name we have never seen', () => {
    expect(isObjectNotFoundError(s3Error('SomeProviderSpecificCode', 404, 'gone'))).toBe(true);
  });

  it('does NOT match AccessDenied', () => {
    // The whole point. A credential that lost its grant must never be reported
    // as missing evidence — they look identical to code that only asks
    // "did it fail", and one of them is a data-loss incident.
    expect(isObjectNotFoundError(s3Error('AccessDenied', 403, 'Access Denied'))).toBe(false);
  });

  it('does NOT match NoSuchBucket, even though it is also a 404', () => {
    // A wrong bucket name would otherwise make every object in the system
    // look deleted at once.
    expect(
      isObjectNotFoundError(s3Error('NoSuchBucket', 404, 'The specified bucket does not exist')),
    ).toBe(false);
  });

  it('does NOT match on the provider wording alone', () => {
    // No $metadata and no SDK error name: just an Error carrying the sentence
    // Wasabi happens to use today. Matching that string would work right up
    // until a provider reworded it, silently.
    expect(isObjectNotFoundError(new Error('The specified key does not exist.'))).toBe(false);
  });

  it('is safe on values that are not errors', () => {
    expect(isObjectNotFoundError(null)).toBe(false);
    expect(isObjectNotFoundError(undefined)).toBe(false);
    expect(isObjectNotFoundError('NoSuchKey')).toBe(false);
  });
});
