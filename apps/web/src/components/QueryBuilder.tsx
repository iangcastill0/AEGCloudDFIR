'use client';
import { Button, IconButton, Select, TextInput } from '@aeg-clouddfir/ui';
import {
  addToGroup,
  builderProblems,
  newCondition,
  newGroup,
  operatorLabel,
  operatorsFor,
  removeNode,
  setConditionField,
  supportsSlop,
  toPreview,
  updateNode,
  valueShape,
  type BuilderCondition,
  type BuilderGroup,
  type BuilderOperator,
  type FieldOption,
  type FieldType,
} from '@/lib/query-builder';

/**
 * The visual query builder: pick a parameter, pick an operator, pick a value.
 *
 * Everything about what a query MEANS lives in lib/query-builder.ts, which is
 * tested without a browser. These components only render that state and dispatch
 * changes, which is why there is no query logic below this comment.
 */

interface Props {
  root: BuilderGroup;
  fields: FieldOption[];
  onChange: (next: BuilderGroup) => void;
  /** Suggested values for a parameter, e.g. the case's tags. */
  suggestions?: Record<string, string[]>;
  /**
   * Mark incomplete conditions. Off until the first Search, so the page does
   * not open covered in warnings about a row nobody has filled in yet.
   */
  showProblems?: boolean;
}

export function QueryBuilder({
  root,
  fields,
  onChange,
  suggestions = {},
  showProblems = false,
}: Props) {
  const types = Object.fromEntries(fields.map((f) => [f.name, f.type]));
  const problems = showProblems ? builderProblems(root) : {};
  const preview = toPreview(root);

  return (
    <div className="qb">
      <div className="qb__preview" aria-live="polite">
        <span className="qb__preview-label">Query preview</span>
        {/* The document calls this the query preview: the builder should never
            run something the reader cannot see written out. */}
        <code>{preview === '' ? 'Nothing selected yet' : preview}</code>
      </div>
      <GroupBox
        node={root}
        depth={0}
        types={types}
        fields={fields}
        problems={problems}
        suggestions={suggestions}
        onChange={onChange}
        root={root}
        isRoot
      />
    </div>
  );
}

interface NodeProps {
  node: BuilderGroup;
  depth: number;
  types: Record<string, FieldType>;
  fields: FieldOption[];
  problems: Record<string, string>;
  suggestions: Record<string, string[]>;
  root: BuilderGroup;
  onChange: (next: BuilderGroup) => void;
  isRoot?: boolean;
}

function GroupBox({
  node,
  depth,
  types,
  fields,
  problems,
  suggestions,
  root,
  onChange,
  isRoot = false,
}: NodeProps) {
  return (
    <fieldset className="qb-group" data-op={node.op} data-depth={depth}>
      <legend className="qb-group__legend">
        <Select
          label="Combine with"
          labelHidden
          value={node.op}
          onChange={(e) =>
            onChange(
              updateNode(root, node.id, (n) =>
                n.kind === 'group' ? { ...n, op: e.target.value as 'and' | 'or' } : n,
              ),
            )
          }
          options={[
            { value: 'and', label: 'AND' },
            { value: 'or', label: 'OR' },
          ]}
        />
        <label className="qb-group__not">
          <input
            type="checkbox"
            checked={node.not}
            onChange={(e) =>
              onChange(
                updateNode(root, node.id, (n) =>
                  n.kind === 'group' ? { ...n, not: e.target.checked } : n,
                ),
              )
            }
          />
          NOT
        </label>
        {isRoot ? null : (
          <IconButton label="Remove this group" onClick={() => onChange(removeNode(root, node.id))}>
            ✕
          </IconButton>
        )}
      </legend>

      <div className="qb-group__children">
        {node.children.map((child) =>
          child.kind === 'group' ? (
            <GroupBox
              key={child.id}
              node={child}
              depth={depth + 1}
              types={types}
              fields={fields}
              problems={problems}
              suggestions={suggestions}
              root={root}
              onChange={onChange}
            />
          ) : (
            <ConditionRow
              key={child.id}
              condition={child}
              types={types}
              fields={fields}
              problem={problems[child.id]}
              suggestions={suggestions}
              root={root}
              onChange={onChange}
            />
          ),
        )}
      </div>

      <div className="qb-group__actions">
        <Button
          type="button"
          variant="ghost"
          small
          onClick={() => onChange(addToGroup(root, node.id, newCondition('body', 'text')))}
        >
          + Add condition
        </Button>
        <Button
          type="button"
          variant="ghost"
          small
          onClick={() =>
            onChange(
              addToGroup(
                root,
                node.id,
                newGroup(node.op === 'and' ? 'or' : 'and', [newCondition('body', 'text')]),
              ),
            )
          }
        >
          + Add group
        </Button>
      </div>
    </fieldset>
  );
}

interface RowProps {
  condition: BuilderCondition;
  types: Record<string, FieldType>;
  fields: FieldOption[];
  problem?: string;
  suggestions: Record<string, string[]>;
  root: BuilderGroup;
  onChange: (next: BuilderGroup) => void;
}

function ConditionRow({
  condition,
  types,
  fields,
  problem,
  suggestions,
  root,
  onChange,
}: RowProps) {
  const type = types[condition.field] ?? 'text';
  const shape = valueShape(condition.operator);
  const choices = suggestions[condition.field];

  const patch = (fn: (c: BuilderCondition) => BuilderCondition) =>
    onChange(updateNode(root, condition.id, (n) => (n.kind === 'condition' ? fn(n) : n)));

  return (
    <div className="qb-condition" data-invalid={problem === undefined ? undefined : 'true'}>
      <Select
        label="Parameter"
        labelHidden
        value={condition.field}
        onChange={(e) =>
          patch((c) => setConditionField(c, e.target.value, types[e.target.value] ?? 'text'))
        }
        options={fields.map((f) => ({ value: f.name, label: f.name }))}
      />
      <Select
        label="Operator"
        labelHidden
        value={condition.operator}
        onChange={(e) => patch((c) => ({ ...c, operator: e.target.value as BuilderOperator }))}
        options={operatorsFor(type).map((op) => ({ value: op, label: operatorLabel(op) }))}
      />

      {shape === 'single' ? (
        choices === undefined ? (
          <TextInput
            label="Value"
            labelHidden
            placeholder={type === 'date' ? 'YYYY-MM-DD' : 'Value'}
            value={condition.value}
            onChange={(e) => patch((c) => ({ ...c, value: e.target.value }))}
          />
        ) : (
          // The document populates the value list for parameters like tags;
          // typing a tag that does not exist is a guaranteed empty result.
          <Select
            label="Value"
            labelHidden
            value={condition.value}
            placeholder="Choose…"
            onChange={(e) => patch((c) => ({ ...c, value: e.target.value }))}
            options={choices.map((v) => ({ value: v, label: v }))}
          />
        )
      ) : null}

      {shape === 'multi' ? (
        <MultiValue
          values={condition.values}
          choices={choices}
          onChange={(values) => patch((c) => ({ ...c, values }))}
        />
      ) : null}

      {supportsSlop(type, condition.operator) ? (
        <TextInput
          label="Slop"
          labelHidden
          placeholder="Optional slop"
          value={condition.slop}
          onChange={(e) => patch((c) => ({ ...c, slop: e.target.value }))}
        />
      ) : null}

      <IconButton
        label="Remove this condition"
        onClick={() => onChange(removeNode(root, condition.id))}
      >
        ✕
      </IconButton>
      {problem === undefined ? null : <span className="qb-condition__problem">{problem}</span>}
    </div>
  );
}

function MultiValue({
  values,
  choices,
  onChange,
}: {
  values: string[];
  choices?: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="qb-values">
      {values.map((value, index) => (
        <div className="qb-values__row" key={`${String(index)}-${value}`}>
          {choices === undefined ? (
            <TextInput
              label={`Value ${String(index + 1)}`}
              labelHidden
              value={value}
              onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
            />
          ) : (
            <Select
              label={`Value ${String(index + 1)}`}
              labelHidden
              value={value}
              placeholder="Choose…"
              onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
              options={choices.map((v) => ({ value: v, label: v }))}
            />
          )}
          <IconButton
            label={`Remove value ${String(index + 1)}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            ✕
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="ghost" small onClick={() => onChange([...values, ''])}>
        + Add value
      </Button>
    </div>
  );
}
