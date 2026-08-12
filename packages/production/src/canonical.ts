/**
 * Deterministic JSON serialization used for manifest hashing.
 *
 * Rules:
 * - object keys recursively sorted (code-unit order), no whitespace
 * - BigInt -> decimal string, Date -> ISO-8601 UTC string
 * - `undefined` properties dropped from objects; `undefined`/missing array
 *   elements serialized as null
 * - non-finite numbers, functions, and symbols throw
 *
 * NOTE: intentionally duplicated from @aeg-clouddfir/evidence — this package
 * must not depend on other workspace packages by design.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite number is not serializable');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type: ${typeof value}`);
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) throw new TypeError('canonicalJson: invalid Date');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
  return `{${entries.join(',')}}`;
}
