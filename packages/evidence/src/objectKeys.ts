import { KeyValidationError } from './errors.js';

/**
 * Pure object-key builders for the AEG-CloudDFIR S3 layout.
 *
 * Key layout contract:
 *   staging     tenants/{tenantId}/staging/{uuid}
 *   original    tenants/{tenantId}/originals/sha256/{first2}/{sha256}
 *   quarantine  tenants/{tenantId}/quarantine/sha256/{first2}/{sha256}
 *   derivative  tenants/{tenantId}/derivatives/{evidenceId}/{type}/{version}/{filename}
 *   manifest    tenants/{tenantId}/manifests/{collectionId}/manifest.json
 *   production  tenants/{tenantId}/productions/{productionId}/{runId}/...
 *   export      tenants/{tenantId}/exports/{exportId}/...
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DERIVATIVE_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Control characters (U+0000..U+001F and U+007F) built at runtime so the
// source file itself stays pure printable ASCII.
const NUL = String.fromCharCode(0);
const CONTROL_RANGE = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const CONTROL_CHARS_RE = new RegExp(`[${CONTROL_RANGE}]`);
const CONTROL_CHARS_ALL_RE = new RegExp(`[${CONTROL_RANGE}]`, 'g');

export type KeyClass =
  | 'original'
  | 'derivative'
  | 'manifest'
  | 'production'
  | 'export'
  | 'staging'
  | 'quarantine'
  | 'unknown';

function assertUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new KeyValidationError(
      `${label} must be a lowercase UUID, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertSha256Hex(value: string, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw new KeyValidationError(
      `${label} must be 64 lowercase hex characters, got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Sanitize a filename for use as the final key segment:
 * strips path separators, NUL and other control characters, and leading dots;
 * collapses runs of dots (so the resulting key can never contain '..');
 * preserves the extension. Never returns an empty string.
 */
export function sanitizeFilename(filename: string): string {
  if (typeof filename !== 'string') {
    throw new KeyValidationError('filename must be a string');
  }
  let name = filename
    .replace(CONTROL_CHARS_ALL_RE, '') // control chars incl. NUL
    .replace(/[/\\]/g, '') // path separators
    .replace(/\.{2,}/g, '.') // collapse dot runs so keys never contain '..'
    .replace(/^\.+/, ''); // leading dots
  name = name.trim();
  if (name.length === 0) return 'file';
  if (name.length > 255) {
    // Keep the extension when truncating.
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 255 - ext.length) + ext;
  }
  return name;
}

function assertPathPart(part: string, label: string): string {
  if (typeof part !== 'string' || part.length === 0) {
    throw new KeyValidationError(`${label} must be a non-empty string`);
  }
  if (/[/\\]/.test(part) || CONTROL_CHARS_RE.test(part) || part.includes('..')) {
    throw new KeyValidationError(
      `${label} must not contain path separators, control characters, or '..': ${JSON.stringify(part)}`,
    );
  }
  if (part.startsWith('.')) {
    throw new KeyValidationError(`${label} must not start with '.': ${JSON.stringify(part)}`);
  }
  return part;
}

export function stagingKey(tenantId: string, uuid: string): string {
  assertUuid(tenantId, 'tenantId');
  assertUuid(uuid, 'uuid');
  return `tenants/${tenantId}/staging/${uuid}`;
}

export function originalKey(tenantId: string, sha256: string): string {
  assertUuid(tenantId, 'tenantId');
  assertSha256Hex(sha256, 'sha256');
  return `tenants/${tenantId}/originals/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function quarantineKey(tenantId: string, sha256: string): string {
  assertUuid(tenantId, 'tenantId');
  assertSha256Hex(sha256, 'sha256');
  return `tenants/${tenantId}/quarantine/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function derivativeKey(
  tenantId: string,
  evidenceId: string,
  derivativeType: string,
  version: number,
  filename: string,
): string {
  assertUuid(tenantId, 'tenantId');
  assertUuid(evidenceId, 'evidenceId');
  if (typeof derivativeType !== 'string' || !DERIVATIVE_TYPE_RE.test(derivativeType)) {
    throw new KeyValidationError(
      `derivativeType must be lowercase alphanumeric/_/-, got: ${JSON.stringify(derivativeType)}`,
    );
  }
  if (!Number.isInteger(version) || version < 0) {
    throw new KeyValidationError(`version must be a non-negative integer, got: ${String(version)}`);
  }
  const safeName = sanitizeFilename(filename);
  return `tenants/${tenantId}/derivatives/${evidenceId}/${derivativeType}/${version}/${safeName}`;
}

export function manifestKey(tenantId: string, collectionId: string): string {
  assertUuid(tenantId, 'tenantId');
  assertUuid(collectionId, 'collectionId');
  return `tenants/${tenantId}/manifests/${collectionId}/manifest.json`;
}

export function productionKey(
  tenantId: string,
  productionId: string,
  runId: string,
  ...parts: string[]
): string {
  assertUuid(tenantId, 'tenantId');
  assertUuid(productionId, 'productionId');
  assertUuid(runId, 'runId');
  if (parts.length === 0) {
    throw new KeyValidationError('productionKey requires at least one path part');
  }
  const safeParts = parts.map((p, i) => assertPathPart(p, `parts[${i}]`));
  return `tenants/${tenantId}/productions/${productionId}/${runId}/${safeParts.join('/')}`;
}

export function exportKey(tenantId: string, exportId: string, ...parts: string[]): string {
  assertUuid(tenantId, 'tenantId');
  assertUuid(exportId, 'exportId');
  if (parts.length === 0) {
    throw new KeyValidationError('exportKey requires at least one path part');
  }
  const safeParts = parts.map((p, i) => assertPathPart(p, `parts[${i}]`));
  return `tenants/${tenantId}/exports/${exportId}/${safeParts.join('/')}`;
}

/**
 * Assert that `key` belongs to `tenantId` and contains no traversal or
 * injection sequences. Throws KeyValidationError (a TypeError) on violation.
 */
export function assertKeyInTenant(tenantId: string, key: string): void {
  assertUuid(tenantId, 'tenantId');
  if (typeof key !== 'string' || key.length === 0) {
    throw new KeyValidationError('key must be a non-empty string');
  }
  if (!key.startsWith(`tenants/${tenantId}/`)) {
    throw new KeyValidationError(`key does not belong to tenant ${tenantId}`);
  }
  if (key.includes('..')) {
    throw new KeyValidationError("key must not contain '..'");
  }
  if (key.includes('//')) {
    throw new KeyValidationError("key must not contain '//'");
  }
  if (key.includes('\\')) {
    throw new KeyValidationError('key must not contain backslashes');
  }
  if (key.includes(NUL)) {
    throw new KeyValidationError('key must not contain NUL characters');
  }
}

/** Classify a key by its layout segment. Returns 'unknown' for anything off-layout. */
export function keyClass(key: string): KeyClass {
  if (typeof key !== 'string') return 'unknown';
  const segments = key.split('/');
  if (segments.length < 4 || segments[0] !== 'tenants') return 'unknown';
  const tenantId = segments[1];
  if (tenantId === undefined || !UUID_RE.test(tenantId)) return 'unknown';
  switch (segments[2]) {
    case 'originals':
      return 'original';
    case 'derivatives':
      return 'derivative';
    case 'manifests':
      return 'manifest';
    case 'productions':
      return 'production';
    case 'exports':
      return 'export';
    case 'staging':
      return 'staging';
    case 'quarantine':
      return 'quarantine';
    default:
      return 'unknown';
  }
}
