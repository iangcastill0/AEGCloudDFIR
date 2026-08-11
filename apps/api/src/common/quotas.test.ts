import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { assertWithinQuota, readQuota, QUOTA_DEFAULTS } from './quotas.js';

describe('readQuota', () => {
  it('returns the documented default when planQuota is empty', () => {
    expect(readQuota({ planQuota: {} }, 'maxConcurrentCollections')).toBe(3);
    expect(readQuota({ planQuota: {} }, 'maxConcurrentExports')).toBe(5);
    expect(readQuota({ planQuota: {} }, 'maxConcurrentProductions')).toBe(2);
    expect(readQuota({ planQuota: {} }, 'maxConnectorAccounts')).toBe(10);
    expect(readQuota({ planQuota: {} }, 'maxCustodians')).toBe(500);
  });

  it('honors a tenant override', () => {
    expect(
      readQuota({ planQuota: { maxConcurrentCollections: 9 } }, 'maxConcurrentCollections'),
    ).toBe(9);
  });

  it('ignores malformed values and falls back to the default', () => {
    expect(
      readQuota({ planQuota: { maxConcurrentCollections: 'lots' } }, 'maxConcurrentCollections'),
    ).toBe(QUOTA_DEFAULTS.maxConcurrentCollections);
    expect(readQuota({ planQuota: null }, 'maxConcurrentExports')).toBe(5);
    expect(readQuota({ planQuota: [1, 2] }, 'maxConcurrentExports')).toBe(5);
    expect(readQuota({ planQuota: { maxConcurrentExports: -1 } }, 'maxConcurrentExports')).toBe(5);
  });
});

describe('assertWithinQuota', () => {
  it('passes while under the limit', () => {
    expect(() => assertWithinQuota('maxConcurrentCollections', 2, 3)).not.toThrow();
  });

  it('throws 409 with structured quota detail once the limit is reached', () => {
    let caught: ConflictException | undefined;
    try {
      assertWithinQuota('maxConcurrentCollections', 3, 3);
    } catch (err) {
      caught = err as ConflictException;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const response = caught?.getResponse() as {
      quota: { key: string; used: number; limit: number };
    };
    expect(response.quota).toEqual({ key: 'maxConcurrentCollections', used: 3, limit: 3 });
  });
});
