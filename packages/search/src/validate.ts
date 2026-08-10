/**
 * AST validation: resolves fields against the registry, enforces cost
 * limits, and normalizes typed values (dates, sizes, hashes, booleans).
 *
 * The output is a ValidatedAst whose leaves carry resolved registry entries;
 * the compiler refuses to work with anything else.
 */

import { QueryValidationError } from './errors.js';
import {
  DEFAULT_TEXT_FIELD,
  HASH_FIELD_NAMES,
  type FieldRegistry,
  type ResolvedField,
} from './fields.js';
import type { QueryNode } from './parser.js';

export interface CostLimits {
  /** Maximum number of leaf clauses in a query. */
  maxClauses: number;
  /** Maximum nesting depth of boolean groups. */
  maxDepth: number;
  /** Minimum literal prefix before the first wildcard character. */
  minWildcardPrefix: number;
  maxFuzzyEdits: number;
  maxProximity: number;
  maxPhraseTerms: number;
}

export const DEFAULT_COST_LIMITS: CostLimits = {
  maxClauses: 64,
  maxDepth: 8,
  minWildcardPrefix: 3,
  maxFuzzyEdits: 2,
  maxProximity: 50,
  maxPhraseTerms: 32,
};

export type ValidatedNode =
  | { kind: 'and' | 'or'; children: ValidatedNode[] }
  | { kind: 'not'; child: ValidatedNode }
  | { kind: 'term'; field: ResolvedField; value: string | number | boolean; fuzzy?: number }
  | { kind: 'phrase'; field: ResolvedField; value: string; proximity?: number }
  | { kind: 'wildcard'; field: ResolvedField; value: string }
  | {
      kind: 'range';
      field: ResolvedField;
      gte?: string | number;
      lte?: string | number;
      gt?: string | number;
      lt?: string | number;
    }
  | { kind: 'exists'; field: ResolvedField }
  | { kind: 'match_all' };

/** Wrapper type so the compiler can only accept validated queries. */
export interface ValidatedAst {
  root: ValidatedNode;
}

type ValidatedTerm = Extract<ValidatedNode, { kind: 'term' }>;
type ValidatedPhrase = Extract<ValidatedNode, { kind: 'phrase' }>;
type ValidatedRange = Extract<ValidatedNode, { kind: 'range' }>;

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const SIZE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/** Parse a size literal like `10mb`, `1kb`, `123` into bytes. */
export function parseSizeValue(value: string): number | null {
  const match = SIZE_PATTERN.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = SIZE_MULTIPLIERS[unit];
  if (multiplier === undefined) return null;
  return Math.round(amount * multiplier);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

/** Parse and normalize a date literal (YYYY-MM-DD or ISO 8601). */
export function parseDateValue(value: string): string | null {
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(ms)) return null;
    return trimmed;
  }
  if (DATE_TIME.test(trimmed)) {
    const ms = Date.parse(trimmed.replace(' ', 'T'));
    if (Number.isNaN(ms)) return null;
    return trimmed.replace(' ', 'T');
  }
  return null;
}

const HASH_PATTERN = /^[0-9a-f]{6,64}$/;

class Validator {
  private readonly registry: FieldRegistry;
  private readonly limits: CostLimits;
  private readonly violations: string[] = [];
  private clauseCount = 0;

  constructor(registry: FieldRegistry, limits: CostLimits) {
    this.registry = registry;
    this.limits = limits;
  }

  validate(root: QueryNode): ValidatedAst {
    const validated = this.walk(root, 1);
    if (this.clauseCount > this.limits.maxClauses) {
      this.violations.push(
        `Query has ${this.clauseCount} clauses, exceeding the maximum of ${this.limits.maxClauses}`,
      );
    }
    if (this.violations.length > 0) {
      throw new QueryValidationError(this.violations);
    }
    if (!validated) {
      throw new QueryValidationError(['Query could not be validated']);
    }
    return { root: validated };
  }

  private fail(message: string): null {
    this.violations.push(message);
    return null;
  }

  private resolveField(name: string | undefined): ResolvedField | null {
    if (name === undefined) return DEFAULT_TEXT_FIELD;
    try {
      return this.registry.resolve(name);
    } catch (error) {
      if (error instanceof QueryValidationError) {
        this.violations.push(...error.violations);
        return null;
      }
      throw error;
    }
  }

  private walk(node: QueryNode, depth: number): ValidatedNode | null {
    if (depth > this.limits.maxDepth) {
      return this.fail(
        `Query nesting depth exceeds the maximum of ${this.limits.maxDepth}`,
      );
    }

    switch (node.kind) {
      case 'match_all':
        return { kind: 'match_all' };
      case 'and':
      case 'or': {
        const children = node.children
          .map((child) => this.walk(child, depth + 1))
          .filter((child): child is ValidatedNode => child !== null);
        if (children.length !== node.children.length) return null;
        return { kind: node.kind, children };
      }
      case 'not': {
        const child = this.walk(node.child, depth + 1);
        return child ? { kind: 'not', child } : null;
      }
      case 'term':
        this.clauseCount += 1;
        return this.validateTerm(node.field, node.value, node.fuzzy);
      case 'phrase':
        this.clauseCount += 1;
        return this.validatePhrase(node.field, node.value, node.proximity);
      case 'wildcard':
        this.clauseCount += 1;
        return this.validateWildcard(node.field, node.value);
      case 'range':
        this.clauseCount += 1;
        return this.validateRange(node);
      case 'exists': {
        this.clauseCount += 1;
        const field = this.resolveField(node.field);
        if (!field) return null;
        if (field.esPath === DEFAULT_TEXT_FIELD.esPath && field.type === 'text') {
          return this.fail('exists queries require a specific field');
        }
        return { kind: 'exists', field };
      }
    }
  }

  private validateTerm(
    fieldName: string | undefined,
    rawValue: string,
    fuzzy: number | undefined,
  ): ValidatedNode | null {
    const field = this.resolveField(fieldName);
    if (!field) return null;

    if (rawValue.length === 0) {
      return this.fail(`Empty value for field "${field.name}"`);
    }

    if (fuzzy !== undefined) {
      if (field.type === 'date' || field.type === 'size' || field.type === 'boolean') {
        return this.fail(`Fuzzy matching is not supported on field "${field.name}"`);
      }
      if (fuzzy > this.limits.maxFuzzyEdits) {
        return this.fail(
          `Fuzzy edit distance ${fuzzy} on "${rawValue}" exceeds the maximum of ${this.limits.maxFuzzyEdits}`,
        );
      }
    }

    switch (field.type) {
      case 'date': {
        const normalized = parseDateValue(rawValue);
        if (normalized === null) {
          return this.fail(
            `Invalid date "${rawValue}" for field "${field.name}" (expected YYYY-MM-DD or ISO 8601)`,
          );
        }
        // Exact date terms become an inclusive range over the value.
        return { kind: 'range', field, gte: normalized, lte: normalized };
      }
      case 'size': {
        const bytes = parseSizeValue(rawValue);
        if (bytes === null) {
          return this.fail(
            `Invalid size "${rawValue}" for field "${field.name}" (expected a number with optional kb/mb/gb suffix)`,
          );
        }
        return { kind: 'term', field, value: bytes };
      }
      case 'boolean': {
        const lowered = rawValue.toLowerCase();
        if (lowered !== 'true' && lowered !== 'false') {
          return this.fail(
            `Invalid boolean "${rawValue}" for field "${field.name}" (expected true or false)`,
          );
        }
        return { kind: 'term', field, value: lowered === 'true' };
      }
      default: {
        let value = rawValue;
        if (HASH_FIELD_NAMES.has(field.name)) {
          value = value.toLowerCase();
          if (!HASH_PATTERN.test(value)) {
            return this.fail(
              `Invalid hash "${rawValue}": expected 6-64 lowercase hex characters`,
            );
          }
        }
        const result: ValidatedTerm = { kind: 'term', field, value };
        if (fuzzy !== undefined) result.fuzzy = fuzzy;
        return result;
      }
    }
  }

  private validatePhrase(
    fieldName: string | undefined,
    value: string,
    proximity: number | undefined,
  ): ValidatedNode | null {
    const field = this.resolveField(fieldName);
    if (!field) return null;

    if (value.trim().length === 0) {
      return this.fail(`Empty phrase for field "${field.name}"`);
    }
    if (field.type === 'date' || field.type === 'size' || field.type === 'boolean') {
      return this.fail(`Phrase queries are not supported on field "${field.name}"`);
    }
    const termCount = value.trim().split(/\s+/).length;
    if (termCount > this.limits.maxPhraseTerms) {
      return this.fail(
        `Phrase has ${termCount} terms, exceeding the maximum of ${this.limits.maxPhraseTerms}`,
      );
    }
    if (proximity !== undefined && proximity > this.limits.maxProximity) {
      return this.fail(
        `Proximity ${proximity} exceeds the maximum of ${this.limits.maxProximity}`,
      );
    }
    const node: ValidatedPhrase = { kind: 'phrase', field, value };
    if (proximity !== undefined) node.proximity = proximity;
    return node;
  }

  private validateWildcard(fieldName: string | undefined, value: string): ValidatedNode | null {
    const field = this.resolveField(fieldName);
    if (!field) return null;

    if (field.type === 'date' || field.type === 'size' || field.type === 'boolean') {
      return this.fail(`Wildcards are not supported on field "${field.name}"`);
    }
    const firstWildcard = Math.min(
      ...['*', '?'].map((c) => {
        const idx = value.indexOf(c);
        return idx === -1 ? Number.POSITIVE_INFINITY : idx;
      }),
    );
    if (firstWildcard === 0) {
      return this.fail(
        `Leading wildcards are forbidden ("${value}"): a wildcard term must start with at least ${this.limits.minWildcardPrefix} literal characters`,
      );
    }
    if (firstWildcard < this.limits.minWildcardPrefix) {
      return this.fail(
        `Wildcard term "${value}" needs at least ${this.limits.minWildcardPrefix} literal characters before the first wildcard`,
      );
    }
    return { kind: 'wildcard', field, value };
  }

  private validateRange(node: {
    field: string;
    gte?: string;
    lte?: string;
    gt?: string;
    lt?: string;
  }): ValidatedNode | null {
    const field = this.resolveField(node.field);
    if (!field) return null;

    if (field.type !== 'date' && field.type !== 'size') {
      return this.fail(
        `Range queries are only supported on date and size fields, not "${field.name}"`,
      );
    }

    const result: ValidatedRange = { kind: 'range', field };
    const bounds: (keyof Pick<typeof node, 'gte' | 'lte' | 'gt' | 'lt'>)[] = [
      'gte',
      'lte',
      'gt',
      'lt',
    ];
    let ok = true;
    for (const bound of bounds) {
      const raw = node[bound];
      if (raw === undefined) continue;
      if (field.type === 'date') {
        const normalized = parseDateValue(raw);
        if (normalized === null) {
          this.fail(
            `Invalid date "${raw}" in range for field "${field.name}" (expected YYYY-MM-DD or ISO 8601)`,
          );
          ok = false;
          continue;
        }
        result[bound] = normalized;
      } else {
        const bytes = parseSizeValue(raw);
        if (bytes === null) {
          this.fail(
            `Invalid size "${raw}" in range for field "${field.name}" (expected a number with optional kb/mb/gb suffix)`,
          );
          ok = false;
          continue;
        }
        result[bound] = bytes;
      }
    }
    if (
      result.gte === undefined &&
      result.lte === undefined &&
      result.gt === undefined &&
      result.lt === undefined
    ) {
      if (ok) this.fail(`Range on "${field.name}" must have at least one bound`);
      ok = false;
    }
    return ok ? result : null;
  }
}

/**
 * Validate a parsed AST against the field registry and cost limits.
 * Throws QueryValidationError listing every violation found.
 */
export function validateAst(
  ast: QueryNode,
  registry: FieldRegistry,
  limits: Partial<CostLimits> = {},
): ValidatedAst {
  const effective: CostLimits = { ...DEFAULT_COST_LIMITS, ...limits };
  return new Validator(registry, effective).validate(ast);
}
