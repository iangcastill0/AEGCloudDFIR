import { ConflictException } from '@nestjs/common';

/** Plan-quota keys honored by create paths. Values live in tenant.planQuota. */
export type QuotaKey =
  | 'maxConcurrentCollections'
  | 'maxConcurrentExports'
  | 'maxConcurrentProductions'
  | 'maxConnectorAccounts'
  | 'maxCustodians';

export const QUOTA_DEFAULTS: Record<QuotaKey, number> = {
  maxConcurrentCollections: 3,
  maxConcurrentExports: 5,
  maxConcurrentProductions: 2,
  maxConnectorAccounts: 10,
  maxCustodians: 500,
};

/** Read a quota from the tenant's planQuota JSON, falling back to defaults. */
export function readQuota(
  tenant: { planQuota: unknown },
  key: QuotaKey,
  defaultValue: number = QUOTA_DEFAULTS[key],
): number {
  const quota = tenant.planQuota;
  if (typeof quota === 'object' && quota !== null && !Array.isArray(quota)) {
    const value = (quota as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return defaultValue;
}

/**
 * Throw a 409 with structured quota detail when `used` has already reached
 * the limit (i.e. one more would exceed it).
 */
export function assertWithinQuota(key: QuotaKey, used: number, limit: number): void {
  if (used >= limit) {
    throw new ConflictException({
      message: `quota exceeded: ${key} allows ${limit}`,
      quota: { key, used, limit },
    });
  }
}
