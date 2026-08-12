import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import type { ProducedItemRecord } from './types.js';

/** Hash record for one physical output file of a produced item. */
export interface ProducedOutputHash {
  path: string;
  sha256: string;
  size: number;
}

export interface ManifestItem extends ProducedItemRecord {
  sha256PerOutput: ProducedOutputHash[];
}

export interface ProductionManifestInput {
  runId: string;
  productionId: string;
  /** The full production parameters as submitted (opaque here). */
  parameters: unknown;
  items: ManifestItem[];
  /** Exceptions recorded during the run (placeholders, conversion failures, ...). */
  exceptions: unknown[];
  batesStart: string;
  batesEnd: string;
  /** Injected by the caller so re-runs over identical inputs stay deterministic. */
  generatedAt: string | Date;
}

export interface ProductionManifest {
  /** Canonical JSON (sorted keys, no whitespace) — byte-stable across runs. */
  json: string;
  /** Lowercase hex SHA-256 of the canonical JSON. */
  sha256: string;
}

/**
 * Build the deterministic manifest for a production run. Identical inputs
 * (including generatedAt) always produce byte-identical JSON and hash;
 * any mutation changes the hash.
 */
export function buildProductionManifest(input: ProductionManifestInput): ProductionManifest {
  const generatedAt =
    input.generatedAt instanceof Date ? input.generatedAt.toISOString() : input.generatedAt;
  const json = canonicalJson({
    schema: 'cdfir.production.manifest.v1',
    runId: input.runId,
    productionId: input.productionId,
    parameters: input.parameters,
    items: input.items,
    exceptions: input.exceptions,
    batesStart: input.batesStart,
    batesEnd: input.batesEnd,
    generatedAt,
  });
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  return { json, sha256 };
}
