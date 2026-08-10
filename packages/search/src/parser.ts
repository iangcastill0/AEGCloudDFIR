/**
 * Recursive-descent parser producing a typed AST from query tokens, plus a
 * zod-validated converter from visual-builder JSON to the same AST.
 *
 * Precedence: NOT > AND (explicit or implicit adjacency) > OR.
 */

import { z } from 'zod';
import { QuerySyntaxError, QueryValidationError } from './errors.js';
import { DEFAULT_FUZZY_EDITS, tokenize, type Token } from './lexer.js';

export interface BoolNode {
  kind: 'and' | 'or';
  children: QueryNode[];
}
export interface NotNode {
  kind: 'not';
  child: QueryNode;
}
export interface TermNode {
  kind: 'term';
  field?: string;
  value: string;
  fuzzy?: number;
}
export interface PhraseNode {
  kind: 'phrase';
  field?: string;
  value: string;
  proximity?: number;
}
export interface WildcardNode {
  kind: 'wildcard';
  field?: string;
  value: string;
}
export interface RangeNode {
  kind: 'range';
  field: string;
  gte?: string;
  lte?: string;
  gt?: string;
  lt?: string;
}
export interface ExistsNode {
  kind: 'exists';
  field: string;
}
export interface MatchAllNode {
  kind: 'match_all';
}

export type QueryNode =
  | BoolNode
  | NotNode
  | TermNode
  | PhraseNode
  | WildcardNode
  | RangeNode
  | ExistsNode
  | MatchAllNode;

function hasWildcard(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

class Parser {
  private readonly tokens: Token[];
  private readonly inputLength: number;
  private i = 0;

  constructor(tokens: Token[], inputLength: number) {
    this.tokens = tokens;
    this.inputLength = inputLength;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.i];
    this.i += 1;
    return token;
  }

  private errorAt(token: Token | undefined, message: string): QuerySyntaxError {
    return new QuerySyntaxError(message, token ? token.pos : this.inputLength);
  }

  parse(): QueryNode {
    if (this.tokens.length === 0) {
      return { kind: 'match_all' };
    }
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing) {
      throw this.errorAt(trailing, `unexpected ${describeToken(trailing)}`);
    }
    return node;
  }

  private parseOr(): QueryNode {
    const children = [this.parseAnd()];
    while (this.peek()?.type === 'or') {
      this.next();
      children.push(this.parseAnd());
    }
    const first = children[0];
    return children.length === 1 && first ? first : { kind: 'or', children };
  }

  private parseAnd(): QueryNode {
    const children = [this.parseNot()];
    for (;;) {
      const token = this.peek();
      if (!token) break;
      if (token.type === 'and') {
        this.next();
        children.push(this.parseNot());
        continue;
      }
      // Implicit adjacency = AND.
      if (
        token.type === 'word' ||
        token.type === 'phrase' ||
        token.type === 'lparen' ||
        token.type === 'not'
      ) {
        children.push(this.parseNot());
        continue;
      }
      break;
    }
    const first = children[0];
    return children.length === 1 && first ? first : { kind: 'and', children };
  }

  private parseNot(): QueryNode {
    const token = this.peek();
    if (token?.type === 'not') {
      this.next();
      return { kind: 'not', child: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode {
    const token = this.next();
    if (!token) {
      throw this.errorAt(undefined, 'unexpected end of query, expected an expression');
    }

    if (token.type === 'lparen') {
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.type !== 'rparen') {
        throw this.errorAt(close, 'unbalanced parenthesis: expected ")"');
      }
      return inner;
    }

    if (token.type === 'phrase') {
      return phraseNode(undefined, token.value, token.proximity);
    }

    if (token.type === 'word') {
      const following = this.peek();
      if (following?.type === 'colon') {
        this.next();
        return this.parseFieldValue(token.value.toLowerCase());
      }
      if (following?.type === 'op') {
        this.next();
        return this.parseComparison(token.value.toLowerCase(), following);
      }
      return wordToNode(token, undefined);
    }

    throw this.errorAt(token, `unexpected ${describeToken(token)}, expected an expression`);
  }

  private parseFieldValue(field: string): QueryNode {
    const token = this.next();
    if (!token) {
      throw this.errorAt(undefined, `expected a value after "${field}:"`);
    }

    if (token.type === 'phrase') {
      return phraseNode(field, token.value, token.proximity);
    }

    if (token.type === 'lbracket') {
      return this.parseBracketRange(field, token);
    }

    if (token.type === 'word') {
      if (token.value === '*' && token.fuzzy === undefined) {
        return { kind: 'exists', field };
      }
      return wordToNode(token, field);
    }

    throw this.errorAt(token, `expected a value after "${field}:", got ${describeToken(token)}`);
  }

  private parseBracketRange(field: string, openToken: Token): QueryNode {
    const lower = this.expectWord('a lower bound (or *)');
    const to = this.expectWord('the keyword TO');
    if (to.value !== 'TO') {
      throw this.errorAt(to, `expected TO between range bounds, got "${to.value}"`);
    }
    const upper = this.expectWord('an upper bound (or *)');
    const close = this.next();
    if (!close || close.type !== 'rbracket') {
      throw this.errorAt(close, 'unbalanced range: expected "]"');
    }
    const node: RangeNode = { kind: 'range', field };
    if (lower.value !== '*') node.gte = lower.value;
    if (upper.value !== '*') node.lte = upper.value;
    if (node.gte === undefined && node.lte === undefined) {
      throw this.errorAt(openToken, 'range must have at least one bound');
    }
    return node;
  }

  private parseComparison(field: string, opToken: Token & { type: 'op' }): QueryNode {
    const value = this.expectWord(`a value after "${field}${opToken.op}"`);
    switch (opToken.op) {
      case '>=':
        return { kind: 'range', field, gte: value.value };
      case '<=':
        return { kind: 'range', field, lte: value.value };
      case '>':
        return { kind: 'range', field, gt: value.value };
      case '<':
        return { kind: 'range', field, lt: value.value };
      case '=':
        return wordToNode(value, field);
    }
  }

  private expectWord(what: string): Token & { type: 'word' } {
    const token = this.next();
    if (!token || token.type !== 'word') {
      throw this.errorAt(token, `expected ${what}`);
    }
    return token;
  }
}

function phraseNode(
  field: string | undefined,
  value: string,
  proximity: number | undefined,
): PhraseNode {
  const node: PhraseNode = { kind: 'phrase', value };
  if (field !== undefined) node.field = field;
  if (proximity !== undefined) node.proximity = proximity;
  return node;
}

function wordToNode(token: Token & { type: 'word' }, field: string | undefined): QueryNode {
  if (token.fuzzy !== undefined) {
    const node: TermNode = { kind: 'term', value: token.value, fuzzy: token.fuzzy };
    if (field !== undefined) node.field = field;
    return node;
  }
  if (hasWildcard(token.value)) {
    const node: WildcardNode = { kind: 'wildcard', value: token.value };
    if (field !== undefined) node.field = field;
    return node;
  }
  const node: TermNode = { kind: 'term', value: token.value };
  if (field !== undefined) node.field = field;
  return node;
}

function describeToken(token: Token): string {
  switch (token.type) {
    case 'word':
      return `"${token.value}"`;
    case 'phrase':
      return `phrase "${token.value}"`;
    case 'op':
      return `"${token.op}"`;
    case 'lparen':
      return '"("';
    case 'rparen':
      return '")"';
    case 'lbracket':
      return '"["';
    case 'rbracket':
      return '"]"';
    case 'colon':
      return '":"';
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'not':
      return 'NOT';
  }
}

/** Parse a raw query string into a typed AST. Throws QuerySyntaxError. */
export function parseQuery(input: string): QueryNode {
  return new Parser(tokenize(input), input.length).parse();
}

// ---------------------------------------------------------------------------
// Visual-builder JSON → AST
// ---------------------------------------------------------------------------

const rangeBoundsSchema = z
  .object({
    gte: z.union([z.string(), z.number()]).optional(),
    lte: z.union([z.string(), z.number()]).optional(),
    gt: z.union([z.string(), z.number()]).optional(),
    lt: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const conditionSchema = z
  .object({
    field: z.string().min(1).optional(),
    operator: z.enum([
      'contains',
      'equals',
      'phrase',
      'starts_with',
      'range',
      'exists',
      'fuzzy',
      'proximity',
    ]),
    value: z.union([z.string(), z.number()]).optional(),
    range: rangeBoundsSchema.optional(),
    /** Proximity distance (slop) for operator "proximity". */
    distance: z.number().int().min(0).optional(),
    /** Edit distance for operator "fuzzy". */
    edits: z.number().int().min(0).optional(),
  })
  .strict();

type BuilderCondition = z.infer<typeof conditionSchema>;

interface BuilderGroup {
  op: 'and' | 'or';
  not?: boolean;
  children: (BuilderGroup | BuilderCondition)[];
}

const groupSchema: z.ZodType<BuilderGroup> = z.lazy(() =>
  z
    .object({
      op: z.enum(['and', 'or']),
      not: z.boolean().optional(),
      children: z.array(z.union([groupSchema, conditionSchema])).min(1),
    })
    .strict(),
);

export type BuilderQuery = BuilderGroup;

function requireValue(condition: BuilderCondition): string {
  if (condition.value === undefined) {
    throw new QueryValidationError([
      `Builder condition with operator "${condition.operator}" requires a value`,
    ]);
  }
  return String(condition.value);
}

function conditionToNode(condition: BuilderCondition): QueryNode {
  const field = condition.field?.toLowerCase();

  switch (condition.operator) {
    case 'contains':
    case 'equals': {
      const node: TermNode = { kind: 'term', value: requireValue(condition) };
      if (field !== undefined) node.field = field;
      return node;
    }
    case 'phrase':
      return phraseNode(field, requireValue(condition), undefined);
    case 'proximity':
      return phraseNode(field, requireValue(condition), condition.distance ?? 1);
    case 'starts_with': {
      const node: WildcardNode = { kind: 'wildcard', value: `${requireValue(condition)}*` };
      if (field !== undefined) node.field = field;
      return node;
    }
    case 'fuzzy': {
      const node: TermNode = {
        kind: 'term',
        value: requireValue(condition),
        fuzzy: condition.edits ?? DEFAULT_FUZZY_EDITS,
      };
      if (field !== undefined) node.field = field;
      return node;
    }
    case 'exists': {
      if (field === undefined) {
        throw new QueryValidationError([
          'Builder condition with operator "exists" requires a field',
        ]);
      }
      return { kind: 'exists', field };
    }
    case 'range': {
      if (field === undefined) {
        throw new QueryValidationError([
          'Builder condition with operator "range" requires a field',
        ]);
      }
      const bounds = condition.range;
      if (
        !bounds ||
        (bounds.gte === undefined &&
          bounds.lte === undefined &&
          bounds.gt === undefined &&
          bounds.lt === undefined)
      ) {
        throw new QueryValidationError([
          'Builder condition with operator "range" requires at least one bound in "range"',
        ]);
      }
      const node: RangeNode = { kind: 'range', field };
      if (bounds.gte !== undefined) node.gte = String(bounds.gte);
      if (bounds.lte !== undefined) node.lte = String(bounds.lte);
      if (bounds.gt !== undefined) node.gt = String(bounds.gt);
      if (bounds.lt !== undefined) node.lt = String(bounds.lt);
      return node;
    }
  }
}

function groupToNode(group: BuilderGroup): QueryNode {
  const children = group.children.map((child) =>
    'operator' in child ? conditionToNode(child) : groupToNode(child),
  );
  const first = children[0];
  const inner: QueryNode = children.length === 1 && first ? first : { kind: group.op, children };
  return group.not === true ? { kind: 'not', child: inner } : inner;
}

/**
 * Convert visual-builder JSON into the same AST the string parser produces.
 * Throws QueryValidationError for malformed input.
 */
export function astFromBuilder(json: unknown): QueryNode {
  const parsed = groupSchema.safeParse(json);
  if (!parsed.success) {
    throw new QueryValidationError(
      parsed.error.issues.map(
        (issue) => `Builder query invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
    );
  }
  return groupToNode(parsed.data);
}
