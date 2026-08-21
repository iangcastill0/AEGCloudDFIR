/**
 * State model for the visual query builder.
 *
 * The builder is the primary way to write a search: you pick a parameter, pick
 * an operator, and pick or type a value, and conditions are grouped with AND/OR
 * boxes that can nest. This file is the whole model — the React components below
 * it only render and dispatch, so every rule about what a query MEANS is
 * testable without a browser.
 *
 * Two outputs matter:
 *  - `toBuilderJson` produces what POST /search accepts, which the API converts
 *    to the same validated AST a typed query produces. Nothing here can widen
 *    what a search reaches; the tenant filter is applied server-side after that.
 *  - `toPreview` renders the equivalent advanced-language text, so the builder
 *    always shows exactly what it is about to run.
 */

/** Operators offered in the builder, in the document's vocabulary. */
export type BuilderOperator =
  | 'contains'
  | 'does_not_contain'
  | 'contains_any_of'
  | 'contains_all_of'
  | 'contains_none_of'
  | 'is'
  | 'is_not'
  | 'is_any_of'
  | 'is_all_of'
  | 'is_none_of'
  | 'exists'
  | 'does_not_exist'
  | 'eq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte';

/** The kinds of value control a condition needs. */
export type ValueShape = 'none' | 'single' | 'multi';

export interface BuilderCondition {
  id: string;
  kind: 'condition';
  field: string;
  operator: BuilderOperator;
  /** Single-value operators. */
  value: string;
  /** Multi-value operators (ANY OF / ALL OF / NONE OF). */
  values: string[];
  /** Slop for a phrase, as "phrase"~N. Empty means none. */
  slop: string;
}

export interface BuilderGroup {
  id: string;
  kind: 'group';
  op: 'and' | 'or';
  not: boolean;
  children: BuilderNode[];
}

export type BuilderNode = BuilderGroup | BuilderCondition;

/** Field types the API reports, mirroring the search package's registry. */
export type FieldType =
  'text' | 'keyword' | 'date' | 'size' | 'address' | 'header' | 'ocr' | 'boolean';

export interface FieldOption {
  name: string;
  type: FieldType;
}

const TEXTUAL: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'ocr', 'header']);
const NUMERIC: ReadonlySet<FieldType> = new Set<FieldType>(['date', 'size']);

/**
 * Which operators make sense for a field.
 *
 * Mirrors the parser's rules, so the builder cannot compose a query the API
 * would reject: text fields get CONTAINS, dates and sizes get comparisons,
 * everything else gets IS. EXISTS applies to all of them.
 */
export function operatorsFor(type: FieldType): BuilderOperator[] {
  if (TEXTUAL.has(type)) {
    return [
      'contains',
      'does_not_contain',
      'contains_any_of',
      'contains_all_of',
      'contains_none_of',
      'exists',
      'does_not_exist',
    ];
  }
  if (NUMERIC.has(type)) {
    return ['eq', 'gt', 'lt', 'gte', 'lte', 'exists', 'does_not_exist'];
  }
  return ['is', 'is_not', 'is_any_of', 'is_all_of', 'is_none_of', 'exists', 'does_not_exist'];
}

/** Label shown in the operator dropdown, in the document's wording. */
export function operatorLabel(op: BuilderOperator): string {
  switch (op) {
    case 'contains':
      return 'CONTAINS';
    case 'does_not_contain':
      return 'DOES NOT CONTAIN';
    case 'contains_any_of':
      return 'CONTAINS ANY OF';
    case 'contains_all_of':
      return 'CONTAINS ALL OF';
    case 'contains_none_of':
      return 'CONTAINS NONE OF';
    case 'is':
      return 'IS';
    case 'is_not':
      return 'IS NOT';
    case 'is_any_of':
      return 'IS ANY OF';
    case 'is_all_of':
      return 'IS ALL OF';
    case 'is_none_of':
      return 'IS NONE OF';
    case 'exists':
      return 'EXISTS';
    case 'does_not_exist':
      return 'DOES NOT EXIST';
    case 'eq':
      return '=';
    case 'gt':
      return '>';
    case 'lt':
      return '<';
    case 'gte':
      return '>=';
    case 'lte':
      return '<=';
  }
}

export function valueShape(op: BuilderOperator): ValueShape {
  if (op === 'exists' || op === 'does_not_exist') return 'none';
  if (op.endsWith('_any_of') || op.endsWith('_all_of') || op.endsWith('_none_of')) return 'multi';
  return 'single';
}

/** Slop only means something for a phrase in a text field. */
export function supportsSlop(type: FieldType, op: BuilderOperator): boolean {
  return TEXTUAL.has(type) && (op === 'contains' || op === 'does_not_contain');
}

// ---------------------------------------------------------------------------
// Construction and editing
// ---------------------------------------------------------------------------

let counter = 0;
/** Ids are for React keys only; they never reach the API. */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

export function newCondition(field = 'body', type: FieldType = 'text'): BuilderCondition {
  return {
    id: nextId('c'),
    kind: 'condition',
    field,
    operator: operatorsFor(type)[0] ?? 'contains',
    value: '',
    values: [],
    slop: '',
  };
}

export function newGroup(op: 'and' | 'or' = 'and', children: BuilderNode[] = []): BuilderGroup {
  return { id: nextId('g'), kind: 'group', op, not: false, children };
}

/** A fresh builder: one empty condition, exactly as the document's view opens. */
export function freshBuilder(): BuilderGroup {
  return newGroup('and', [newCondition()]);
}

function mapNode(
  node: BuilderNode,
  id: string,
  fn: (n: BuilderNode) => BuilderNode | null,
): BuilderNode | null {
  if (node.id === id) return fn(node);
  if (node.kind === 'group') {
    const children = node.children
      .map((child) => mapNode(child, id, fn))
      .filter((child): child is BuilderNode => child !== null);
    return { ...node, children };
  }
  return node;
}

/** Replace one node. Returns the tree unchanged if the id is not present. */
export function updateNode(
  root: BuilderGroup,
  id: string,
  fn: (n: BuilderNode) => BuilderNode,
): BuilderGroup {
  const next = mapNode(root, id, fn);
  return next && next.kind === 'group' ? next : root;
}

/**
 * Remove a node.
 *
 * A group that loses its last child is removed too: an empty group has no
 * meaning and the API rejects it (`children` must have at least one entry). The
 * root always survives, because there has to be somewhere to add the next
 * condition.
 */
export function removeNode(root: BuilderGroup, id: string): BuilderGroup {
  if (root.id === id) return freshBuilder();
  const pruned = mapNode(root, id, () => null);
  const cleaned = pruned && pruned.kind === 'group' ? dropEmptyGroups(pruned) : root;
  return cleaned.children.length === 0 ? { ...cleaned, children: [newCondition()] } : cleaned;
}

function dropEmptyGroups(group: BuilderGroup): BuilderGroup {
  const children = group.children
    .map((child) => (child.kind === 'group' ? dropEmptyGroups(child) : child))
    .filter((child) => child.kind === 'condition' || child.children.length > 0);
  return { ...group, children };
}

/** Add a child to a specific group. */
export function addToGroup(root: BuilderGroup, groupId: string, child: BuilderNode): BuilderGroup {
  return updateNode(root, groupId, (node) =>
    node.kind === 'group' ? { ...node, children: [...node.children, child] } : node,
  );
}

/** Changing the field resets the operator when the old one no longer applies. */
export function setConditionField(
  condition: BuilderCondition,
  field: string,
  type: FieldType,
): BuilderCondition {
  const allowed = operatorsFor(type);
  const operator = allowed.includes(condition.operator)
    ? condition.operator
    : (allowed[0] ?? 'contains');
  return {
    ...condition,
    field,
    operator,
    // A value typed for a different kind of field is usually wrong; a slop value
    // is meaningless off a text phrase.
    slop: supportsSlop(type, operator) ? condition.slop : '',
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Human-readable reason a condition is not ready, or null when it is. */
export function conditionProblem(condition: BuilderCondition): string | null {
  if (condition.field.trim() === '') return 'Choose a parameter';
  const shape = valueShape(condition.operator);
  if (shape === 'single' && condition.value.trim() === '') return 'Enter a value';
  if (shape === 'multi' && condition.values.filter((v) => v.trim() !== '').length === 0) {
    return 'Add at least one value';
  }
  if (condition.slop.trim() !== '' && !/^\d+$/.test(condition.slop.trim())) {
    return 'Slop must be a whole number';
  }
  return null;
}

/** Every incomplete condition in the tree, so the UI can mark each one. */
export function builderProblems(root: BuilderGroup): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: BuilderNode): void => {
    if (node.kind === 'condition') {
      const problem = conditionProblem(node);
      if (problem !== null) out[node.id] = problem;
      return;
    }
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * True when nothing has been filled in yet.
 *
 * A pristine builder means "no query", the same as an empty search box: the
 * rail's own filters still apply, so "everything in this case" is reachable
 * without inventing a condition. Only a PARTLY filled builder is an error.
 */
export function isPristine(root: BuilderGroup): boolean {
  const empty = (node: BuilderNode): boolean =>
    node.kind === 'group'
      ? node.children.every(empty)
      : node.value.trim() === '' &&
        node.values.every((v) => v.trim() === '') &&
        node.slop.trim() === '';
  return empty(root);
}

export function isRunnable(root: BuilderGroup): boolean {
  return Object.keys(builderProblems(root)).length === 0;
}

// ---------------------------------------------------------------------------
// Output: the API's builder JSON
// ---------------------------------------------------------------------------

interface JsonCondition {
  field: string;
  operator: 'contains' | 'equals' | 'phrase' | 'proximity' | 'exists' | 'range';
  value?: string;
  distance?: number;
  range?: { gt?: string; lt?: string; gte?: string; lte?: string };
}
interface JsonGroup {
  op: 'and' | 'or';
  not?: boolean;
  children: (JsonGroup | JsonCondition)[];
}

function valueCondition(
  condition: BuilderCondition,
  value: string,
  textual: boolean,
): JsonCondition {
  const slop = condition.slop.trim();
  if (textual && slop !== '') {
    return { field: condition.field, operator: 'proximity', value, distance: Number(slop) };
  }
  // A quoted-looking value is a phrase; otherwise a term. Matching how the text
  // language reads it keeps the two entry paths equivalent.
  if (textual && /\s/.test(value.trim())) {
    return { field: condition.field, operator: 'phrase', value: value.trim() };
  }
  return { field: condition.field, operator: textual ? 'contains' : 'equals', value: value.trim() };
}

function conditionToJson(condition: BuilderCondition, type: FieldType): JsonGroup | JsonCondition {
  const textual = TEXTUAL.has(type);
  const op = condition.operator;

  if (op === 'exists') return { field: condition.field, operator: 'exists' };
  if (op === 'does_not_exist') {
    return { op: 'and', not: true, children: [{ field: condition.field, operator: 'exists' }] };
  }

  if (op === 'eq') return valueCondition(condition, condition.value, false);
  if (op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') {
    return { field: condition.field, operator: 'range', range: { [op]: condition.value.trim() } };
  }

  const shape = valueShape(op);
  if (shape === 'multi') {
    const values = condition.values.map((v) => v.trim()).filter((v) => v !== '');
    // ANY OF is an OR of the values, ALL OF an AND, NONE OF a negated OR —
    // exactly what the document says these are shorthand for.
    const inner: JsonGroup = {
      op: op.endsWith('_all_of') ? 'and' : 'or',
      children: values.map((v) => valueCondition(condition, v, textual)),
    };
    return op.endsWith('_none_of') ? { op: 'and', not: true, children: [inner] } : inner;
  }

  const single = valueCondition(condition, condition.value, textual);
  return op === 'does_not_contain' || op === 'is_not'
    ? { op: 'and', not: true, children: [single] }
    : single;
}

/** Convert the builder tree into the JSON that POST /search accepts. */
export function toBuilderJson(root: BuilderGroup, types: Record<string, FieldType>): JsonGroup {
  const convert = (node: BuilderNode): JsonGroup | JsonCondition =>
    node.kind === 'condition'
      ? conditionToJson(node, types[node.field] ?? 'text')
      : {
          op: node.op,
          ...(node.not ? { not: true } : {}),
          children: node.children.map(convert),
        };
  const converted = convert(root);
  // The root is always a group, even when it holds a single condition.
  return 'op' in converted ? converted : { op: 'and', children: [converted] };
}

// ---------------------------------------------------------------------------
// Output: the readable preview
// ---------------------------------------------------------------------------

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function conditionPreview(condition: BuilderCondition): string {
  const label = operatorLabel(condition.operator);
  const shape = valueShape(condition.operator);
  if (shape === 'none') return `${condition.field} ${label}`;
  if (shape === 'multi') {
    const values = condition.values
      .filter((v) => v.trim() !== '')
      .map((v) => quoteIfNeeded(v.trim()));
    return `${condition.field} ${label} (${values.join(', ')})`;
  }
  const slop = condition.slop.trim();
  const value = quoteIfNeeded(condition.value.trim());
  const withSlop = slop === '' ? value : `${value}~${slop}`;
  return `${condition.field} ${label} ${withSlop}`;
}

/**
 * Render the tree as advanced-language text.
 *
 * This is the document's "query preview": the builder should never run something
 * the reader cannot see written down.
 */
export function toPreview(node: BuilderNode): string {
  if (node.kind === 'condition') return conditionPreview(node);
  const parts = node.children.map((child) => {
    const text = toPreview(child);
    // Parenthesise a nested group so the reader sees the precedence.
    return child.kind === 'group' && child.children.length > 1 ? `(${text})` : text;
  });
  const joined = parts.join(node.op === 'and' ? ' AND ' : ' OR ');
  return node.not ? `NOT (${joined})` : joined;
}
