import { describe, expect, it } from 'vitest';
import {
  addToGroup,
  builderProblems,
  conditionProblem,
  freshBuilder,
  isPristine,
  isRunnable,
  newCondition,
  newGroup,
  operatorLabel,
  operatorsFor,
  removeNode,
  setConditionField,
  supportsSlop,
  toBuilderJson,
  toPreview,
  updateNode,
  valueShape,
  type BuilderCondition,
  type FieldType,
} from './query-builder.js';

const TYPES: Record<string, FieldType> = {
  body: 'text',
  subject: 'text',
  tags: 'keyword',
  custodian: 'keyword',
  from: 'address',
  date: 'date',
  size: 'size',
  privileged: 'boolean',
};

function condition(over: Partial<BuilderCondition> = {}): BuilderCondition {
  return { ...newCondition(), ...over };
}

describe('operatorsFor', () => {
  it('offers CONTAINS for text and IS for keywords, mirroring the parser', () => {
    // If the builder offered an operator the parser rejects, the UI could
    // compose a query that cannot run.
    expect(operatorsFor('text')).toContain('contains');
    expect(operatorsFor('text')).not.toContain('is');
    expect(operatorsFor('keyword')).toContain('is');
    expect(operatorsFor('keyword')).not.toContain('contains');
  });

  it('offers comparisons for dates and sizes', () => {
    expect(operatorsFor('date')).toEqual(expect.arrayContaining(['eq', 'gt', 'lt', 'gte', 'lte']));
    expect(operatorsFor('size')).toContain('gte');
  });

  it('offers EXISTS for every type', () => {
    for (const type of ['text', 'keyword', 'date', 'size', 'address', 'boolean'] as FieldType[]) {
      expect(operatorsFor(type)).toContain('exists');
    }
  });

  it('labels operators the way the document writes them', () => {
    expect(operatorLabel('contains_any_of')).toBe('CONTAINS ANY OF');
    expect(operatorLabel('gte')).toBe('>=');
  });
});

describe('value shapes', () => {
  it('EXISTS needs no value, ANY OF needs several', () => {
    expect(valueShape('exists')).toBe('none');
    expect(valueShape('does_not_exist')).toBe('none');
    expect(valueShape('is_any_of')).toBe('multi');
    expect(valueShape('contains_none_of')).toBe('multi');
    expect(valueShape('contains')).toBe('single');
  });

  it('slop applies only to a text CONTAINS', () => {
    expect(supportsSlop('text', 'contains')).toBe(true);
    expect(supportsSlop('keyword', 'is')).toBe(false);
    expect(supportsSlop('text', 'contains_any_of')).toBe(false);
  });
});

describe('editing the tree', () => {
  it('opens with one empty condition, like the document’s view', () => {
    const root = freshBuilder();
    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.kind).toBe('condition');
  });

  it('adds a condition to a nested group, not the root', () => {
    const inner = newGroup('or');
    const root = addToGroup(freshBuilder(), '', inner); // no-op id
    const withGroup = addToGroup(root, root.id, inner);
    const added = addToGroup(withGroup, inner.id, newCondition('tags', 'keyword'));
    const target = added.children.find((c) => c.id === inner.id);
    expect(target?.kind).toBe('group');
    if (target?.kind === 'group') expect(target.children).toHaveLength(1);
  });

  it('changing the parameter resets an operator that no longer applies', () => {
    // body CONTAINS → tags cannot CONTAIN; it would be rejected server-side.
    const c = condition({ field: 'body', operator: 'contains', slop: '3' });
    const moved = setConditionField(c, 'tags', 'keyword');
    expect(moved.operator).toBe('is');
    expect(moved.slop).toBe('');
  });

  it('keeps a still-valid operator when the parameter changes', () => {
    const c = condition({ field: 'body', operator: 'does_not_contain' });
    expect(setConditionField(c, 'subject', 'text').operator).toBe('does_not_contain');
  });

  it('removing the last child of a group removes the group too', () => {
    // The API rejects an empty group, and it means nothing on screen.
    const inner = newGroup('or', [newCondition('tags', 'keyword')]);
    const root = addToGroup(freshBuilder(), '', inner);
    const withGroup = { ...root, children: [...root.children, inner] };
    const child = inner.children[0];
    const pruned = removeNode(withGroup, child?.id ?? '');
    expect(pruned.children.some((c) => c.id === inner.id)).toBe(false);
  });

  it('never leaves the root empty', () => {
    const root = freshBuilder();
    const only = root.children[0];
    const pruned = removeNode(root, only?.id ?? '');
    expect(pruned.children).toHaveLength(1);
  });

  it('updates one condition without touching its siblings', () => {
    const a = newCondition('body', 'text');
    const b = newCondition('subject', 'text');
    const root = newGroup('and', [a, b]);
    const next = updateNode(root, a.id, (n) =>
      n.kind === 'condition' ? { ...n, value: 'insurance' } : n,
    );
    expect((next.children[0] as BuilderCondition).value).toBe('insurance');
    expect((next.children[1] as BuilderCondition).value).toBe('');
  });
});

describe('validation', () => {
  it('asks for a value when one is needed', () => {
    expect(conditionProblem(condition({ operator: 'contains', value: '' }))).toBe('Enter a value');
  });

  it('accepts EXISTS with no value', () => {
    expect(conditionProblem(condition({ operator: 'exists' }))).toBeNull();
  });

  it('requires at least one value for ANY OF', () => {
    expect(conditionProblem(condition({ operator: 'is_any_of', values: ['  '] }))).toBe(
      'Add at least one value',
    );
    expect(conditionProblem(condition({ operator: 'is_any_of', values: ['a'] }))).toBeNull();
  });

  it('rejects a non-numeric slop', () => {
    expect(conditionProblem(condition({ operator: 'contains', value: 'a b', slop: 'x' }))).toBe(
      'Slop must be a whole number',
    );
  });

  it('reports every incomplete condition, so each can be marked', () => {
    const good = condition({ value: 'ok' });
    const bad = condition({ value: '' });
    const root = newGroup('and', [good, newGroup('or', [bad])]);
    const problems = builderProblems(root);
    expect(Object.keys(problems)).toEqual([bad.id]);
    expect(isRunnable(root)).toBe(false);
    expect(isRunnable(newGroup('and', [good]))).toBe(true);
  });
});

describe('toPreview — what the builder says it will run', () => {
  it('renders a single condition the way the document writes it', () => {
    expect(toPreview(condition({ field: 'body', operator: 'contains', value: 'insurance' }))).toBe(
      'body CONTAINS insurance',
    );
  });

  it('quotes a multi-word value', () => {
    expect(
      toPreview(condition({ field: 'body', operator: 'contains', value: 'create file' })),
    ).toBe('body CONTAINS "create file"');
  });

  it('shows slop after the phrase', () => {
    expect(
      toPreview(
        condition({ field: 'body', operator: 'contains', value: 'wire transfer', slop: '3' }),
      ),
    ).toBe('body CONTAINS "wire transfer"~3');
  });

  it('renders a value list', () => {
    expect(
      toPreview(
        condition({ field: 'tags', operator: 'is_any_of', values: ['Documentation', 'FROM ZIPS'] }),
      ),
    ).toBe('tags IS ANY OF (Documentation, "FROM ZIPS")');
  });

  it('matches the document’s worked example', () => {
    // body CONTAINS Categorization AND (type = docx OR tags = Documentation)
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'Categorization' }),
      newGroup('or', [
        condition({ field: 'ext', operator: 'is', value: 'docx' }),
        condition({ field: 'tags', operator: 'is', value: 'Documentation' }),
      ]),
    ]);
    expect(toPreview(root)).toBe(
      'body CONTAINS Categorization AND (ext IS docx OR tags IS Documentation)',
    );
  });

  it('shows a negated group as NOT (...)', () => {
    const root = {
      ...newGroup('or', [condition({ field: 'tags', operator: 'is', value: 'a' })]),
      not: true,
    };
    expect(toPreview(root)).toBe('NOT (tags IS a)');
  });

  it('does not parenthesise a group holding one condition', () => {
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'x' }),
      newGroup('or', [condition({ field: 'tags', operator: 'is', value: 'y' })]),
    ]);
    expect(toPreview(root)).toBe('body CONTAINS x AND tags IS y');
  });
});

describe('toBuilderJson — what the API receives', () => {
  it('sends a text condition as contains', () => {
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'insurance' }),
    ]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [{ field: 'body', operator: 'contains', value: 'insurance' }],
    });
  });

  it('sends a multi-word text value as a phrase, like the text language reads it', () => {
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'wire transfer' }),
    ]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [{ field: 'body', operator: 'phrase', value: 'wire transfer' }],
    });
  });

  it('sends slop as a proximity condition', () => {
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'wire transfer', slop: '3' }),
    ]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [{ field: 'body', operator: 'proximity', value: 'wire transfer', distance: 3 }],
    });
  });

  it('sends a keyword IS as equals', () => {
    const root = newGroup('and', [condition({ field: 'tags', operator: 'is', value: 'Hot' })]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [{ field: 'tags', operator: 'equals', value: 'Hot' }],
    });
  });

  it('negates IS NOT with a not-group, because conditions have no negation', () => {
    const root = newGroup('and', [condition({ field: 'tags', operator: 'is_not', value: 'Hot' })]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [
        { op: 'and', not: true, children: [{ field: 'tags', operator: 'equals', value: 'Hot' }] },
      ],
    });
  });

  it('expands ANY OF into an OR group', () => {
    const root = newGroup('and', [
      condition({ field: 'tags', operator: 'is_any_of', values: ['a', 'b'] }),
    ]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [
        {
          op: 'or',
          children: [
            { field: 'tags', operator: 'equals', value: 'a' },
            { field: 'tags', operator: 'equals', value: 'b' },
          ],
        },
      ],
    });
  });

  it('expands ALL OF into an AND group and NONE OF into a negated OR', () => {
    const all = toBuilderJson(
      newGroup('and', [condition({ field: 'tags', operator: 'is_all_of', values: ['a', 'b'] })]),
      TYPES,
    );
    expect(JSON.stringify(all)).toContain('"op":"and"');
    const none = toBuilderJson(
      newGroup('and', [condition({ field: 'tags', operator: 'is_none_of', values: ['a', 'b'] })]),
      TYPES,
    );
    expect(JSON.stringify(none)).toContain('"not":true');
  });

  it('sends comparisons as ranges', () => {
    const root = newGroup('and', [
      condition({ field: 'date', operator: 'gte', value: '2026-01-01' }),
    ]);
    expect(toBuilderJson(root, TYPES)).toEqual({
      op: 'and',
      children: [{ field: 'date', operator: 'range', range: { gte: '2026-01-01' } }],
    });
  });

  it('sends EXISTS, and DOES NOT EXIST as its negation', () => {
    expect(
      toBuilderJson(newGroup('and', [condition({ field: 'bates', operator: 'exists' })]), TYPES),
    ).toEqual({ op: 'and', children: [{ field: 'bates', operator: 'exists' }] });
    expect(
      toBuilderJson(
        newGroup('and', [condition({ field: 'bates', operator: 'does_not_exist' })]),
        TYPES,
      ),
    ).toEqual({
      op: 'and',
      children: [{ op: 'and', not: true, children: [{ field: 'bates', operator: 'exists' }] }],
    });
  });

  it('keeps nesting and carries a negated group through', () => {
    const root = newGroup('and', [
      condition({ field: 'body', operator: 'contains', value: 'x' }),
      { ...newGroup('or', [condition({ field: 'tags', operator: 'is', value: 'y' })]), not: true },
    ]);
    const json = toBuilderJson(root, TYPES);
    expect(json.children).toHaveLength(2);
    expect(JSON.stringify(json)).toContain('"not":true');
  });

  it('trims values, so a stray space does not become part of the search', () => {
    const root = newGroup('and', [condition({ field: 'tags', operator: 'is', value: '  Hot  ' })]);
    expect(JSON.stringify(toBuilderJson(root, TYPES))).toContain('"value":"Hot"');
  });
});

describe('isPristine — an empty builder means "no query", not "invalid"', () => {
  it('is pristine when nothing has been typed', () => {
    expect(isPristine(freshBuilder())).toBe(true);
  });

  it('stops being pristine once a value is entered', () => {
    const root = freshBuilder();
    const first = root.children[0];
    if (first?.kind !== 'condition') throw new Error('expected a condition');
    expect(isPristine(updateNode(root, first.id, (n) => ({ ...n, value: 'x' }) as typeof n))).toBe(
      false,
    );
  });

  it('is pristine even with several untouched conditions and groups', () => {
    const root = newGroup('and', [newCondition(), newGroup('or', [newCondition()])]);
    expect(isPristine(root)).toBe(true);
  });
});
