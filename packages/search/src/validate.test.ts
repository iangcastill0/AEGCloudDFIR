import { describe, expect, it } from 'vitest';
import { QueryValidationError } from './errors.js';
import { DEFAULT_FIELD_REGISTRY } from './fields.js';
import { parseQuery } from './parser.js';
import {
  parseDateValue,
  parseSizeValue,
  validateAst,
  type CostLimits,
  type ValidatedNode,
} from './validate.js';

function validate(query: string, limits: Partial<CostLimits> = {}) {
  return validateAst(parseQuery(query), DEFAULT_FIELD_REGISTRY, limits);
}

function violationsOf(query: string, limits: Partial<CostLimits> = {}): string[] {
  try {
    validate(query, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryValidationError);
    return (error as QueryValidationError).violations;
  }
  return expect.unreachable() as never;
}

describe('field resolution', () => {
  it('rejects unknown fields and lists the allowed fields', () => {
    const violations = violationsOf('nosuchfield:x');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Unknown field "nosuchfield"');
    expect(violations[0]).toContain('subject');
    expect(violations[0]).toContain('from');
    expect(violations[0]).toContain('header.<name>');
  });

  it('rejects raw document paths like tenantId — tenancy is not queryable', () => {
    expect(violationsOf('tenantId:other-tenant')[0]).toContain('Unknown field');
    expect(violationsOf('caseids:sneaky')[0]).toContain('Unknown field');
    expect(violationsOf('hasBeenProduced:true')[0]).toContain('Unknown field');
  });

  it('resolves fields case-insensitively', () => {
    const ast = validate('FROM:alice@example.com');
    expect(ast.root).toMatchObject({
      kind: 'term',
      field: { name: 'from', esPath: 'email.from', type: 'address' },
    });
  });

  it('resolves dynamic header fields', () => {
    const ast = validate('header.X-Originating-IP:10.0.0.1');
    expect(ast.root).toMatchObject({
      kind: 'term',
      field: { type: 'header', esPath: 'headers', headerName: 'x-originating-ip' },
    });
  });

  it('rejects header. with no name', () => {
    expect(violationsOf('header.:x')[0]).toContain('header.<name>');
  });

  it('uses the all-text default field for unfielded terms', () => {
    const ast = validate('invoice');
    expect(ast.root).toMatchObject({ kind: 'term', field: { name: 'text', esPath: '*' } });
  });
});

describe('wildcard limits', () => {
  it('forbids leading wildcards', () => {
    expect(violationsOf('*foo')[0]).toContain('Leading wildcards are forbidden');
    expect(violationsOf('?foo')[0]).toContain('Leading wildcards are forbidden');
    expect(violationsOf('name:*foo')[0]).toContain('Leading wildcards are forbidden');
  });

  it('requires a minimum literal prefix', () => {
    expect(violationsOf('ab*')[0]).toContain('at least 3 literal characters');
    expect(violationsOf('a?c')[0]).toContain('at least 3 literal characters');
  });

  it('accepts wildcards with a sufficient prefix', () => {
    expect(validate('abc*').root).toMatchObject({ kind: 'wildcard', value: 'abc*' });
    expect(validate('name:report-??.pdf').root).toMatchObject({ kind: 'wildcard' });
  });

  it('honors a custom minWildcardPrefix', () => {
    expect(violationsOf('abcd*', { minWildcardPrefix: 5 })[0]).toContain(
      'at least 5 literal characters',
    );
  });

  it('rejects wildcards on date and size fields', () => {
    expect(violationsOf('sent:2024*')[0]).toContain('Wildcards are not supported');
  });
});

describe('cost limits', () => {
  it('rejects a clause bomb over maxClauses', () => {
    const query = Array.from({ length: 65 }, (_, i) => `term${i}`).join(' OR ');
    expect(violationsOf(query)[0]).toContain('65 clauses');
  });

  it('accepts exactly maxClauses clauses', () => {
    const query = Array.from({ length: 64 }, (_, i) => `term${i}`).join(' OR ');
    expect(() => validate(query)).not.toThrow();
  });

  it('rejects a depth bomb over maxDepth', () => {
    let query = 'a AND b';
    for (let i = 0; i < 9; i += 1) {
      query = `(${query}) OR c${i} AND d${i}`;
    }
    expect(violationsOf(query).some((v) => v.includes('nesting depth'))).toBe(true);
  });

  it('honors a custom maxDepth', () => {
    expect(
      violationsOf('a AND (b OR (c AND d))', { maxDepth: 3 }).some((v) =>
        v.includes('nesting depth'),
      ),
    ).toBe(true);
    expect(() => validate('a AND (b OR c)', { maxDepth: 3 })).not.toThrow();
  });

  it('rejects fuzzy edit distances over the limit', () => {
    expect(violationsOf('receit~3')[0]).toContain('exceeds the maximum of 2');
    expect(() => validate('receit~2')).not.toThrow();
  });

  it('rejects proximity over the limit', () => {
    expect(violationsOf('"a b"~51')[0]).toContain('Proximity 51 exceeds');
    expect(() => validate('"a b"~50')).not.toThrow();
  });

  it('rejects phrases with too many terms', () => {
    const phrase = Array.from({ length: 33 }, (_, i) => `w${i}`).join(' ');
    expect(violationsOf(`"${phrase}"`)[0]).toContain('33 terms');
  });
});

describe('date values', () => {
  it('accepts YYYY-MM-DD and ISO datetimes', () => {
    expect(() => validate('sent>=2024-01-01')).not.toThrow();
    expect(() => validate('sent>=2024-01-01T10:30:00Z')).not.toThrow();
    expect(() => validate('received:[2024-01-01 TO 2024-06-30]')).not.toThrow();
  });

  it('turns an exact date term into an inclusive range', () => {
    const ast = validate('sent:2024-01-01');
    expect(ast.root).toMatchObject({
      kind: 'range',
      gte: '2024-01-01',
      lte: '2024-01-01',
    });
  });

  it('rejects malformed dates', () => {
    expect(violationsOf('sent:notadate')[0]).toContain('Invalid date');
    expect(violationsOf('sent>=01/02/2024')[0]).toContain('Invalid date');
    expect(violationsOf('received:[2024-13-99 TO 2024-06-30]')[0]).toContain('Invalid date');
  });

  it('parseDateValue normalizes space-separated datetimes', () => {
    expect(parseDateValue('2024-01-01 10:30:00')).toBe('2024-01-01T10:30:00');
    expect(parseDateValue('2024-01-01')).toBe('2024-01-01');
    expect(parseDateValue('garbage')).toBeNull();
  });
});

describe('size values', () => {
  it('converts kb/mb/gb suffixes to bytes', () => {
    expect(parseSizeValue('10mb')).toBe(10 * 1024 * 1024);
    expect(parseSizeValue('1kb')).toBe(1024);
    expect(parseSizeValue('2GB')).toBe(2 * 1024 * 1024 * 1024);
    expect(parseSizeValue('123')).toBe(123);
    expect(parseSizeValue('1.5kb')).toBe(1536);
  });

  it('rejects malformed sizes', () => {
    expect(parseSizeValue('10xb')).toBeNull();
    expect(parseSizeValue('mb')).toBeNull();
    expect(violationsOf('size>10xb')[0]).toContain('Invalid size');
  });

  it('normalizes size ranges to bytes', () => {
    const ast = validate('size:[1kb TO 5mb]');
    expect(ast.root).toMatchObject({ kind: 'range', gte: 1024, lte: 5 * 1024 * 1024 });
  });

  it('normalizes exact size terms to bytes', () => {
    expect(validate('size:2kb').root).toMatchObject({ kind: 'term', value: 2048 });
  });
});

describe('hash values', () => {
  it('lowercases hashes', () => {
    expect(validate('hash:ABCDEF123456').root).toMatchObject({
      kind: 'term',
      value: 'abcdef123456',
    });
    expect(validate('sha256:DEADBEEF00').root).toMatchObject({ value: 'deadbeef00' });
  });

  it('rejects non-hex and too-short hashes', () => {
    expect(violationsOf('hash:xyz123')[0]).toContain('Invalid hash');
    expect(violationsOf('hash:abc')[0]).toContain('Invalid hash');
  });
});

describe('booleans and ranges', () => {
  it('parses boolean fields', () => {
    expect(validate('privileged:true').root).toMatchObject({ kind: 'term', value: true });
    expect(validate('produced:FALSE').root).toMatchObject({ kind: 'term', value: false });
  });

  it('rejects non-boolean values on boolean fields', () => {
    expect(violationsOf('privileged:maybe')[0]).toContain('Invalid boolean');
  });

  it('rejects ranges on text/keyword fields', () => {
    expect(violationsOf('subject:[a TO b]')[0]).toContain('only supported on date and size');
    expect(violationsOf('custodian>=a')[0]).toContain('only supported on date and size');
  });

  it('rejects phrase queries on date/size/boolean fields', () => {
    expect(violationsOf('sent:"2024-01-01"')[0]).toContain('Phrase queries are not supported');
  });

  it('rejects exists on the all-text default field', () => {
    expect(violationsOf('text:*')[0]).toContain('specific field');
  });
});

describe('violation aggregation', () => {
  it('collects every violation in one error', () => {
    const violations = violationsOf('*foo AND receit~9 AND nosuchfield:x AND sent:junk');
    expect(violations).toHaveLength(4);
    expect(violations.join('\n')).toContain('Leading wildcards');
    expect(violations.join('\n')).toContain('exceeds the maximum');
    expect(violations.join('\n')).toContain('Unknown field');
    expect(violations.join('\n')).toContain('Invalid date');
  });

  it('produces a validated tree with resolved fields on success', () => {
    const ast = validate('from:a@x.com AND size>1mb');
    expect(ast.root.kind).toBe('and');
    const children = (ast.root as Extract<ValidatedNode, { kind: 'and' }>).children;
    expect(children[0]).toMatchObject({ field: { esPath: 'email.from' } });
    expect(children[1]).toMatchObject({ field: { esPath: 'size' }, gt: 1024 * 1024 });
  });
});
