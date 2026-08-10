/**
 * Tokenizer for the EvidenceVault query language.
 *
 * The raw user string is only ever consumed here — downstream stages operate
 * on tokens/AST, never on the raw string, so nothing user-provided is ever
 * forwarded verbatim to OpenSearch.
 */

import { QuerySyntaxError } from './errors.js';

export type ComparisonOp = '>=' | '<=' | '>' | '<' | '=';

export type Token =
  | { type: 'lparen'; pos: number }
  | { type: 'rparen'; pos: number }
  | { type: 'lbracket'; pos: number }
  | { type: 'rbracket'; pos: number }
  | { type: 'colon'; pos: number }
  | { type: 'and'; pos: number }
  | { type: 'or'; pos: number }
  | { type: 'not'; pos: number }
  | { type: 'op'; op: ComparisonOp; pos: number }
  | { type: 'phrase'; value: string; proximity?: number; pos: number }
  | { type: 'word'; value: string; fuzzy?: number; pos: number };

const WHITESPACE = /\s/;
/** Characters that terminate a bare word. */
const WORD_BREAK = new Set(['(', ')', '[', ']', ':', '"', '<', '>', '=', '&', '|']);

/** Default fuzzy edit distance when written as `term~` with no number. */
export const DEFAULT_FUZZY_EDITS = 2;

function readNumber(input: string, start: number): { value: number; end: number } | null {
  let end = start;
  while (end < input.length) {
    const ch = input.charAt(end);
    if (ch >= '0' && ch <= '9') end += 1;
    else break;
  }
  if (end === start) return null;
  return { value: Number.parseInt(input.slice(start, end), 10), end };
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input.charAt(i);

    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', pos: i });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', pos: i });
      i += 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ type: 'lbracket', pos: i });
      i += 1;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: 'rbracket', pos: i });
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', pos: i });
      i += 1;
      continue;
    }

    if (ch === '&') {
      if (input.charAt(i + 1) !== '&') {
        throw new QuerySyntaxError(`unexpected "&" — use && or AND`, i);
      }
      tokens.push({ type: 'and', pos: i });
      i += 2;
      continue;
    }
    if (ch === '|') {
      if (input.charAt(i + 1) !== '|') {
        throw new QuerySyntaxError(`unexpected "|" — use || or OR`, i);
      }
      tokens.push({ type: 'or', pos: i });
      i += 2;
      continue;
    }

    if (ch === '>' || ch === '<') {
      if (input.charAt(i + 1) === '=') {
        tokens.push({ type: 'op', op: ch === '>' ? '>=' : '<=', pos: i });
        i += 2;
      } else {
        tokens.push({ type: 'op', op: ch, pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: 'op', op: '=', pos: i });
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
        if (c === '\\') {
          const next = input.charAt(i + 1);
          if (next === '"' || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          value += c;
          i += 1;
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
      let proximity: number | undefined;
      if (input.charAt(i) === '~') {
        const num = readNumber(input, i + 1);
        if (!num) {
          throw new QuerySyntaxError('expected a number after "~" for proximity', i);
        }
        proximity = num.value;
        i = num.end;
      }
      const token: Token = { type: 'phrase', value, pos: start };
      if (proximity !== undefined) token.proximity = proximity;
      tokens.push(token);
      continue;
    }

    // Bare word: read until whitespace or a break character. `~` is consumed
    // as part of the word and post-processed as a fuzzy suffix. A `:` stays
    // inside the word only when it is part of an ISO time (e.g. the colons in
    // 2024-01-01T10:30:00Z), never after a field-like name.
    const start = i;
    let word = '';
    while (i < input.length) {
      const c = input.charAt(i);
      if (c === ':' && /(T\d{2}|:\d{2})$/.test(word)) {
        word += c;
        i += 1;
        continue;
      }
      if (WHITESPACE.test(c) || WORD_BREAK.has(c)) break;
      word += c;
      i += 1;
    }
    if (word.length === 0) {
      throw new QuerySyntaxError(`unexpected character "${ch}"`, i);
    }

    if (word === 'AND') {
      tokens.push({ type: 'and', pos: start });
      continue;
    }
    if (word === 'OR') {
      tokens.push({ type: 'or', pos: start });
      continue;
    }
    if (word === 'NOT') {
      tokens.push({ type: 'not', pos: start });
      continue;
    }

    const fuzzyMatch = /^(.*?)~(\d*)$/.exec(word);
    if (fuzzyMatch) {
      const base = fuzzyMatch[1] ?? '';
      const digits = fuzzyMatch[2] ?? '';
      if (base.length === 0) {
        throw new QuerySyntaxError('fuzzy operator "~" requires a preceding term', start);
      }
      if (base.includes('~')) {
        throw new QuerySyntaxError('multiple "~" operators in one term', start);
      }
      tokens.push({
        type: 'word',
        value: base,
        fuzzy: digits.length > 0 ? Number.parseInt(digits, 10) : DEFAULT_FUZZY_EDITS,
        pos: start,
      });
      continue;
    }
    if (word.includes('~')) {
      throw new QuerySyntaxError('"~" is only valid as a term suffix (term~ or term~2)', start);
    }

    tokens.push({ type: 'word', value: word, pos: start });
  }

  return tokens;
}
