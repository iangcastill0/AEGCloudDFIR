import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { sortedMerkleRoot } from './merkle.js';

/**
 * Collection manifests: signed JSON with per-item SHA-256 hashes and a
 * deterministic Merkle root. The completeness vocabulary is deliberately
 * narrow and honest — absolute claims like "complete" are rejected.
 */

export const COMPLETENESS_VALUES = [
  'complete_within_selected_api_scope',
  'complete_with_exceptions',
  'partial',
  'failed',
  'cancelled',
] as const;

export type Completeness = (typeof COMPLETENESS_VALUES)[number];

export interface ManifestCustodian {
  id: string;
  email: string;
  displayName: string;
}

export interface ManifestException {
  kind: string;
  message: string;
  providerItemId?: string;
  custodianId?: string;
}

export interface ManifestItem {
  evidenceItemId: string;
  providerItemId: string;
  custodianId: string;
  sha256: string;
  size: number;
  objectKey: string;
  acquiredAt: string;
  apiExportDerivative?: boolean;
}

export interface ProviderReportedTotal {
  value: number;
  caveat: string;
}

export interface ManifestCounts {
  discovered: number;
  fetched: number;
  preserved: number;
  skipped: number;
  errors: number;
  providerReportedTotals?: ProviderReportedTotal[];
}

export interface ManifestCollection {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  permissionMode: 'delegated' | 'organization';
  provider: 'microsoft' | 'google';
  connectorLabel: string;
  connectorExternalIdentity: string;
  custodians: ManifestCustodian[];
  scope: unknown;
  startedAt: string;
  finishedAt: string;
  apiEndpoints: string[];
}

export interface ManifestApplication {
  name: string;
  version: string;
  parserVersions: Record<string, string>;
}

export interface CollectionManifestV1 {
  schemaVersion: '1';
  application: ManifestApplication;
  collection: ManifestCollection;
  counts: ManifestCounts;
  completeness: Completeness;
  completenessNarrative: string;
  exceptions: ManifestException[];
  items: ManifestItem[];
  merkleRoot: string;
  generatedAt: string;
}

export type BuildManifestInput = Omit<
  CollectionManifestV1,
  'schemaVersion' | 'merkleRoot' | 'generatedAt'
>;

export interface ManifestSignature {
  signature: string;
  algorithm: 'HMAC-SHA256';
  keyId?: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isCompleteness(value: string): value is Completeness {
  return (COMPLETENESS_VALUES as readonly string[]).includes(value);
}

/**
 * Build a v1 collection manifest: validates the completeness vocabulary,
 * validates item hashes, computes the order-independent Merkle root, and
 * stamps generatedAt.
 *
 * Absolute completeness claims ('complete', 'all data', ...) are rejected —
 * the only allowed values are the honest vocabulary in COMPLETENESS_VALUES.
 */
export function buildManifest(input: BuildManifestInput): CollectionManifestV1 {
  const completeness: string = input.completeness;
  if (!isCompleteness(completeness)) {
    throw new TypeError(
      `invalid completeness value ${JSON.stringify(completeness)}; ` +
        `allowed values are: ${COMPLETENESS_VALUES.join(', ')} ` +
        '(absolute claims such as "complete" or "all data" are not permitted)',
    );
  }
  for (const item of input.items) {
    if (!SHA256_HEX_RE.test(item.sha256)) {
      throw new TypeError(
        `item ${item.evidenceItemId} has an invalid sha256 (must be 64 lowercase hex characters)`,
      );
    }
    if (!Number.isInteger(item.size) || item.size < 0) {
      throw new TypeError(`item ${item.evidenceItemId} has an invalid size`);
    }
  }
  return {
    schemaVersion: '1',
    application: input.application,
    collection: input.collection,
    counts: input.counts,
    completeness,
    completenessNarrative: input.completenessNarrative,
    exceptions: input.exceptions,
    items: input.items,
    merkleRoot: sortedMerkleRoot(input.items.map((i) => i.sha256)),
    generatedAt: new Date().toISOString(),
  };
}

/** Deterministic canonical-JSON serialization; same manifest -> same bytes. */
export function serializeManifest(manifest: CollectionManifestV1): string {
  return canonicalJson(manifest);
}

/** Sign serialized manifest bytes with HMAC-SHA256. */
export function signManifest(
  serialized: string,
  signingKey: Buffer,
  keyId?: string,
): ManifestSignature {
  if (signingKey.byteLength === 0) {
    throw new TypeError('signingKey must not be empty');
  }
  const signature = createHmac('sha256', signingKey).update(serialized, 'utf8').digest('hex');
  const result: ManifestSignature = { signature, algorithm: 'HMAC-SHA256' };
  if (keyId !== undefined) result.keyId = keyId;
  return result;
}

/** Constant-time verification of a manifest HMAC signature. */
export function verifyManifestSignature(
  serialized: string,
  signature: string,
  key: Buffer,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', key).update(serialized, 'utf8').digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(expected, provided);
}

const COMPLETENESS_WORDING: Record<Completeness, string> = {
  complete_within_selected_api_scope:
    'Complete within the selected API scope. No items known to the API within scope were missed.',
  complete_with_exceptions:
    'Complete within the selected API scope, with documented exceptions listed below.',
  partial: 'PARTIAL collection: some in-scope items were not preserved. See exceptions below.',
  failed: 'FAILED collection: the collection did not finish. Results must not be relied upon as complete.',
  cancelled:
    'CANCELLED collection: the collection was stopped before finishing. Results must not be relied upon as complete.',
};

/**
 * Render a human-readable completeness report. Uses honest wording only:
 * completeness is always qualified by account, permission, and API scope.
 */
export function renderCompletenessReport(m: CollectionManifestV1): string {
  const lines: string[] = [];
  lines.push(`Collection Completeness Report`);
  lines.push(`==============================`);
  lines.push(`Collection: ${m.collection.name} (${m.collection.id})`);
  lines.push(`Tenant: ${m.collection.tenantId}`);
  lines.push(`Provider: ${m.collection.provider} (${m.collection.permissionMode} permissions)`);
  lines.push(`Connector: ${m.collection.connectorLabel} [${m.collection.connectorExternalIdentity}]`);
  lines.push(`Custodians: ${m.collection.custodians.map((c) => c.email).join(', ') || '(none)'}`);
  lines.push(`Window: ${m.collection.startedAt} to ${m.collection.finishedAt}`);
  lines.push(`Generated: ${m.generatedAt}`);
  lines.push('');
  lines.push('Counts');
  lines.push('------');
  lines.push(`  discovered: ${m.counts.discovered}`);
  lines.push(`  fetched:    ${m.counts.fetched}`);
  lines.push(`  preserved:  ${m.counts.preserved}`);
  lines.push(`  skipped:    ${m.counts.skipped}`);
  lines.push(`  errors:     ${m.counts.errors}`);
  if (m.counts.providerReportedTotals !== undefined) {
    for (const t of m.counts.providerReportedTotals) {
      lines.push(`  provider-reported total: ${t.value} (caveat: ${t.caveat})`);
    }
  }
  lines.push('');
  lines.push(`Completeness: ${m.completeness}`);
  lines.push(COMPLETENESS_WORDING[m.completeness]);
  lines.push('');
  lines.push(`Narrative: ${m.completenessNarrative}`);
  lines.push('');
  lines.push(`Exceptions: ${m.exceptions.length}`);
  lines.push('----------');
  if (m.exceptions.length === 0) {
    lines.push('  (none recorded)');
  } else {
    const byKind = new Map<string, number>();
    for (const ex of m.exceptions) {
      byKind.set(ex.kind, (byKind.get(ex.kind) ?? 0) + 1);
    }
    for (const [kind, count] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${kind}: ${count}`);
    }
    for (const ex of m.exceptions) {
      const where = [
        ex.custodianId !== undefined ? `custodian=${ex.custodianId}` : null,
        ex.providerItemId !== undefined ? `item=${ex.providerItemId}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join(' ');
      lines.push(`  - [${ex.kind}] ${ex.message}${where.length > 0 ? ` (${where})` : ''}`);
    }
  }
  lines.push('');
  lines.push(`Items preserved: ${m.items.length}`);
  lines.push(`Merkle root (SHA-256, sorted leaves): ${m.merkleRoot}`);
  lines.push('');
  lines.push(
    'Scope caveat: any statement of completeness (including "all time") means items ' +
      'returned within the selected account, permissions, API-visible scope, retention ' +
      'state, and provider limitations. It is not a claim that every item that ever ' +
      'existed was collected.',
  );
  return lines.join('\n');
}
