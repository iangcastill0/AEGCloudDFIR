/**
 * The "advanced" query language: `parameter OPERATOR value`, as described in
 * docs/guides/advanced-search.md.
 *
 * It is a second SPELLING of the existing query model, not a second model. It
 * produces the same typed AST as `parseQuery`, so validation, cost limits and —
 * critically — the tenant filter injected in `compile` are shared. A new front
 * end therefore cannot widen what a query is able to reach.
 *
 * Two deliberate differences from the `field:value` language:
 *  - an operator between conditions is REQUIRED. Adjacency means AND there; here
 *    it is nearly always a typo, and guessing would silently change what a
 *    reviewer searched and may certify.
 *  - operators are checked against the field's type, so `tags CONTAINS x` is an
 *    error that names `IS` rather than a query that quietly matches nothing.
 */

import { QuerySyntaxError } from './errors.js';
import { DEFAULT_FIELD_REGISTRY, FieldRegistry, type FieldType } from './fields.js';
import type { QueryNode } from './parser.js';

/**
 * Names from the reference document mapped onto this app's fields.
 *
 * Only parameters this app can actually answer appear here. The document also
 * lists imported Bates numbers, review sets, processing state, privilege
 * categories and page counts; this app has no equivalent, so those names are
 * rejected with a suggestion instead of being silently accepted.
 */
const PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  // General
  content: 'text',
  type: 'extension',
  'name.ext': 'extension',
  'name.dirs': 'folder',
  directory: 'folder',
  'name.term': 'name',
  // Dates
  'ingestion-date': 'acquired',
  'sent-date': 'sent',
  'received-date': 'received',
  // Email addresses, written dotted in the document
  'to.address': 'to',
  'from.address': 'from',
  'cc.address': 'cc',
  'bcc.address': 'bcc',
  'participant.address': 'participants',
  'sender.address': 'sender',
  'replyto.address': 'replyto',
  // Other
  'system-tags': 'labels',
  'document-notes': 'text',
};

/** Every parameter the advanced language accepts, for help text and completion. */
export const ADVANCED_PARAMETERS: readonly string[] = [
  ...new Set([...DEFAULT_FIELD_REGISTRY.allowedFields(), ...Object.keys(PARAMETER_ALIASES)]),
]
  .filter((name) => name !== 'header.<name>')
  .sort();

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Tok =
  | { type: 'lparen'; pos: number }
  | { type: 'rparen'; pos: number }
  | { type: 'comma'; pos: number }
  | { type: 'op'; op: '>=' | '<=' | '>' | '<' | '='; pos: number }
  | { type: 'phrase'; value: string; proximity?: number; pos: number }
  | { type: 'word'; value: string; pos: number };

const WORD_BREAK = new Set(['(', ')', ',', '"', '<', '>', '=']);

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      out.push({ type: 'lparen', pos: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      out.push({ type: 'rparen', pos: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      out.push({ type: 'comma', pos: i });
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      const two = input.charAt(i + 1) === '=';
      out.push({ type: 'op', op: two ? (`${ch}=` as '>=' | '<=') : ch, pos: i });
      i += two ? 2 : 1;
      continue;
    }
    if (ch === '=') {
      out.push({ type: 'op', op: '=', pos: i });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let value = '';
      let closed = false;
      while (i < input.length) {
        const c = input.charAt(i);
        if (c === '\\' && i + 1 < input.length) {
          value += input.charAt(i + 1);
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) {
        throw new QuerySyntaxError('unterminated quoted phrase', start);
      }
      // Slop, written "phrase"~3 exactly as the document describes.
      let proximity: number | undefined;
      if (input.charAt(i) === '~') {
        let j = i + 1;
        let digits = '';
        while (j < input.length && input.charAt(j) >= '0' && input.charAt(j) <= '9') {
          digits += input.charAt(j);
          j += 1;
        }
        if (digits === '') {
          throw new QuerySyntaxError('expected a slop value after ~, e.g. "a phrase"~3', i);
        }
        proximity = Number(digits);
        i = j;
      }
      out.push(
        proximity === undefined
          ? { type: 'phrase', value, pos: start }
          : { type: 'phrase', value, proximity, pos: start },
      );
      continue;
    }
    const start = i;
    let word = '';
    while (i < input.length) {
      const c = input.charAt(i);
      if (/\s/.test(c) || WORD_BREAK.has(c)) break;
      word += c;
      i += 1;
    }
    if (word === '') {
      throw new QuerySyntaxError(`unexpected character "${ch}"`, i);
    }
    out.push({ type: 'word', value: word, pos: start });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/** Levenshtein distance, small inputs only — used to suggest a near miss. */
function distance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * The parameters worth naming when nothing is close.
 *
 * A curated handful beats an alphabetical dump of 60: the point is to get the
 * reader moving again, and the full list is one click away in the query help.
 */
const COMMON_PARAMETERS: readonly string[] = [
  'body',
  'subject',
  'name',
  'from.address',
  'to.address',
  'tags',
  'date',
  'custodian',
  'name.ext',
];

function suggest(name: string): string[] {
  const scored = [...ADVANCED_PARAMETERS]
    .map((candidate) => ({ candidate, d: distance(name.toLowerCase(), candidate.toLowerCase()) }))
    .sort((x, y) => x.d - y.d);
  // Generous threshold: a near miss is worth guessing at, and a wrong guess
  // costs the reader nothing because the message shows the alternatives too.
  return scored
    .filter((entry) => entry.d <= Math.max(4, Math.ceil(name.length / 2)))
    .slice(0, 3)
    .map((e) => e.candidate);
}

interface ResolvedParam {
  field: string;
  type: FieldType;
}

function resolveParameter(raw: string, pos: number, registry: FieldRegistry): ResolvedParam {
  const lower = raw.toLowerCase();
  const mapped = PARAMETER_ALIASES[lower] ?? lower;
  try {
    const resolved = registry.resolve(mapped);
    return { field: resolved.name, type: resolved.type };
  } catch {
    // Always name valid parameters: refusing without saying what IS allowed
    // just moves the guesswork somewhere else.
    const hints = suggest(raw);
    const tail =
      hints.length > 0
        ? ` Did you mean ${hints.map((h) => `"${h}"`).join(', ')}?`
        : ` Supported parameters include ${COMMON_PARAMETERS.join(', ')} — see the query help for all ${String(ADVANCED_PARAMETERS.length)}.`;
    throw new QuerySyntaxError(`unknown parameter "${raw}".${tail}`, pos);
  }
}

/** Which operator family a field's type accepts, and what to say when it does not. */
function operatorFamily(type: FieldType): 'contains' | 'is' | 'compare' {
  switch (type) {
    case 'text':
    case 'ocr':
    case 'header':
      return 'contains';
    case 'date':
    case 'size':
      return 'compare';
    default:
      return 'is';
  }
}

const FAMILY_ADVICE: Record<'contains' | 'is' | 'compare', string> = {
  contains: 'use CONTAINS (or DOES NOT CONTAIN)',
  is: 'use IS (or IS NOT)',
  compare: 'use a comparison: =, >, <, >= or <=',
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'contains',
  'is',
  'exists',
  'exist',
  'does',
  'any',
  'all',
  'none',
  'of',
]);

class AdvancedParser {
  private i = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly end: number,
    private readonly registry: FieldRegistry,
  ) {}

  private peek(offset = 0): Tok | undefined {
    return this.toks[this.i + offset];
  }

  private next(): Tok | undefined {
    const t = this.toks[this.i];
    this.i += 1;
    return t;
  }

  private posOf(t: Tok | undefined): number {
    return t ? t.pos : this.end;
  }

  /** Consume the given keyword sequence if present; otherwise leave the cursor. */
  private tryKeywords(...words: string[]): boolean {
    for (let k = 0; k < words.length; k += 1) {
      const t = this.peek(k);
      if (!t || t.type !== 'word' || t.value.toLowerCase() !== words[k]) return false;
    }
    this.i += words.length;
    return true;
  }

  private isKeyword(t: Tok | undefined, word: string): boolean {
    return t !== undefined && t.type === 'word' && t.value.toLowerCase() === word;
  }

  parse(): QueryNode {
    if (this.toks.length === 0) return { kind: 'match_all' };
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing) {
      throw new QuerySyntaxError(
        'unexpected text; conditions must be joined with AND, OR or NOT',
        trailing.pos,
      );
    }
    return node;
  }

  private parseOr(): QueryNode {
    const children = [this.parseAnd()];
    while (this.isKeyword(this.peek(), 'or')) {
      this.next();
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0]! : { kind: 'or', children };
  }

  private parseAnd(): QueryNode {
    const children = [this.parseUnary()];
    while (this.isKeyword(this.peek(), 'and')) {
      this.next();
      children.push(this.parseUnary());
    }
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  }

  private parseUnary(): QueryNode {
    if (this.isKeyword(this.peek(), 'not')) {
      this.next();
      return { kind: 'not', child: this.parseUnary() };
    }
    const t = this.peek();
    if (t?.type === 'lparen') {
      this.next();
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.type !== 'rparen') {
        throw new QuerySyntaxError('expected a closing parenthesis', this.posOf(close));
      }
      return inner;
    }
    return this.parseCondition();
  }

  private parseCondition(): QueryNode {
    const nameTok = this.next();
    if (!nameTok || nameTok.type !== 'word') {
      throw new QuerySyntaxError('expected a parameter name', this.posOf(nameTok));
    }
    if (KEYWORDS.has(nameTok.value.toLowerCase())) {
      throw new QuerySyntaxError(
        `expected a parameter name, found the operator "${nameTok.value}"`,
        nameTok.pos,
      );
    }
    const param = resolveParameter(nameTok.value, nameTok.pos, this.registry);
    const family = operatorFamily(param.type);

    // EXISTS / DOES NOT EXIST — allowed for every field type.
    if (this.tryKeywords('exists')) {
      return { kind: 'exists', field: param.field };
    }
    if (this.tryKeywords('does', 'not', 'exist')) {
      return { kind: 'not', child: { kind: 'exists', field: param.field } };
    }

    // DOES NOT CONTAIN [ANY OF (...)]
    if (this.tryKeywords('does', 'not', 'contain')) {
      this.requireFamily(family, 'contains', nameTok, 'DOES NOT CONTAIN');
      if (this.tryKeywords('any', 'of')) {
        return { kind: 'not', child: this.combine(this.valueList(param), 'or') };
      }
      return { kind: 'not', child: this.singleValue(param) };
    }

    const opTok = this.peek();

    if (this.isKeyword(opTok, 'contains')) {
      this.next();
      this.requireFamily(family, 'contains', nameTok, 'CONTAINS');
      if (this.tryKeywords('any', 'of')) return this.combine(this.valueList(param), 'or');
      if (this.tryKeywords('all', 'of')) return this.combine(this.valueList(param), 'and');
      if (this.tryKeywords('none', 'of')) {
        return { kind: 'not', child: this.combine(this.valueList(param), 'or') };
      }
      return this.singleValue(param);
    }

    if (this.isKeyword(opTok, 'is')) {
      this.next();
      this.requireFamily(family, 'is', nameTok, 'IS');
      if (this.tryKeywords('any', 'of')) return this.combine(this.valueList(param), 'or');
      if (this.tryKeywords('all', 'of')) return this.combine(this.valueList(param), 'and');
      if (this.tryKeywords('none', 'of')) {
        return { kind: 'not', child: this.combine(this.valueList(param), 'or') };
      }
      if (this.tryKeywords('not', 'all', 'of')) {
        return { kind: 'not', child: this.combine(this.valueList(param), 'and') };
      }
      if (this.tryKeywords('not')) {
        return { kind: 'not', child: this.singleValue(param) };
      }
      return this.singleValue(param);
    }

    if (opTok?.type === 'op') {
      this.next();
      if (family !== 'compare') {
        throw new QuerySyntaxError(
          `"${nameTok.value}" does not take a comparison; ${FAMILY_ADVICE[family]}`,
          opTok.pos,
        );
      }
      const value = this.next();
      if (!value || (value.type !== 'word' && value.type !== 'phrase')) {
        throw new QuerySyntaxError(`expected a value after "${opTok.op}"`, this.posOf(value));
      }
      switch (opTok.op) {
        case '>=':
          return { kind: 'range', field: param.field, gte: value.value };
        case '<=':
          return { kind: 'range', field: param.field, lte: value.value };
        case '>':
          return { kind: 'range', field: param.field, gt: value.value };
        case '<':
          return { kind: 'range', field: param.field, lt: value.value };
        case '=':
          return this.valueNode(param, value);
      }
    }

    throw new QuerySyntaxError(
      `expected an operator after "${nameTok.value}" — ${FAMILY_ADVICE[family]}, or EXISTS`,
      this.posOf(opTok),
    );
  }

  private requireFamily(
    actual: 'contains' | 'is' | 'compare',
    wanted: 'contains' | 'is' | 'compare',
    nameTok: Tok & { type: 'word' },
    used: string,
  ): void {
    if (actual === wanted) return;
    throw new QuerySyntaxError(
      `"${nameTok.value}" does not support ${used}; ${FAMILY_ADVICE[actual]}`,
      nameTok.pos,
    );
  }

  /** `(a, "b c", d)` — the document's +Add Value list. */
  private valueList(param: ResolvedParam): QueryNode[] {
    const open = this.next();
    if (!open || open.type !== 'lparen') {
      throw new QuerySyntaxError('expected "(" to start a list of values', this.posOf(open));
    }
    const nodes: QueryNode[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.type === 'rparen') {
        this.next();
        break;
      }
      const value = this.next();
      if (!value || (value.type !== 'word' && value.type !== 'phrase')) {
        throw new QuerySyntaxError('expected a value', this.posOf(value));
      }
      nodes.push(this.valueNode(param, value));
      const sep = this.peek();
      if (sep?.type === 'comma') {
        this.next();
        continue;
      }
      if (sep?.type === 'rparen') {
        this.next();
        break;
      }
      throw new QuerySyntaxError('expected a comma or ")" in the list of values', this.posOf(sep));
    }
    if (nodes.length === 0) {
      throw new QuerySyntaxError('a list of values cannot be empty', this.posOf(open));
    }
    return nodes;
  }

  private singleValue(param: ResolvedParam): QueryNode {
    const value = this.next();
    if (!value || (value.type !== 'word' && value.type !== 'phrase')) {
      throw new QuerySyntaxError('expected a value', this.posOf(value));
    }
    return this.valueNode(param, value);
  }

  /** One value → the same node the `field:value` parser would produce. */
  private valueNode(param: ResolvedParam, tok: Tok & { type: 'word' | 'phrase' }): QueryNode {
    if (tok.type === 'phrase') {
      return tok.proximity === undefined
        ? { kind: 'phrase', field: param.field, value: tok.value }
        : { kind: 'phrase', field: param.field, value: tok.value, proximity: tok.proximity };
    }
    if (tok.value.includes('*') || tok.value.includes('?')) {
      return { kind: 'wildcard', field: param.field, value: tok.value };
    }
    return { kind: 'term', field: param.field, value: tok.value };
  }

  /** One value is not a group: `IS ANY OF (x)` must equal `IS x`. */
  private combine(nodes: QueryNode[], kind: 'and' | 'or'): QueryNode {
    return nodes.length === 1 ? nodes[0]! : { kind, children: nodes };
  }
}

/** Parse an advanced-syntax query into the shared AST. */
export function parseAdvancedQuery(
  input: string,
  registry: FieldRegistry = DEFAULT_FIELD_REGISTRY,
): QueryNode {
  return new AdvancedParser(tokenize(input), input.length, registry).parse();
}
