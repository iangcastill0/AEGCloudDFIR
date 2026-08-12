'use client';
import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

interface FieldChrome {
  label: string;
  hint?: ReactNode;
  error?: string;
}

function useFieldIds(explicitId: string | undefined) {
  const autoId = useId();
  const id = explicitId ?? autoId;
  return { id, hintId: `${id}-hint`, errorId: `${id}-error` };
}

function describedBy(hintId: string, errorId: string, hint?: ReactNode, error?: string) {
  const ids: string[] = [];
  if (hint) ids.push(hintId);
  if (error) ids.push(errorId);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface TextInputProps
  extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {}

export function TextInput({ label, hint, error, id: explicitId, ...rest }: TextInputProps) {
  const { id, hintId, errorId } = useFieldIds(explicitId);
  return (
    <div className="cdfir-field">
      <label className="cdfir-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="cdfir-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        className="cdfir-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId, hint, error)}
        {...rest}
      />
      {error ? (
        <p className="cdfir-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextAreaProps
  extends FieldChrome, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'> {}

export function TextArea({ label, hint, error, id: explicitId, ...rest }: TextAreaProps) {
  const { id, hintId, errorId } = useFieldIds(explicitId);
  return (
    <div className="cdfir-field">
      <label className="cdfir-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="cdfir-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        className="cdfir-textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId, hint, error)}
        {...rest}
      />
      {error ? (
        <p className="cdfir-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends FieldChrome, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
  placeholder?: string;
}

export function Select({
  label,
  hint,
  error,
  options,
  placeholder,
  id: explicitId,
  ...rest
}: SelectProps) {
  const { id, hintId, errorId } = useFieldIds(explicitId);
  return (
    <div className="cdfir-field">
      <label className="cdfir-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="cdfir-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        className="cdfir-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId, hint, error)}
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="cdfir-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'children' | 'type'
> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, id: explicitId, ...rest }: CheckboxProps) {
  const { id, hintId } = useFieldIds(explicitId);
  return (
    <div className="cdfir-checkbox">
      <input type="checkbox" id={id} aria-describedby={hint ? hintId : undefined} {...rest} />
      <span>
        <label htmlFor={id}>{label}</label>
        {hint ? (
          <p className="cdfir-field__hint" id={hintId}>
            {hint}
          </p>
        ) : null}
      </span>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export function RadioGroup({ legend, name, options, value, onChange, error }: RadioGroupProps) {
  const groupId = useId();
  const errorId = `${groupId}-error`;
  return (
    <fieldset className="cdfir-fieldset" aria-describedby={error ? errorId : undefined}>
      <legend>{legend}</legend>
      {options.map((option) => {
        const id = `${groupId}-${option.value}`;
        return (
          <div className="cdfir-radio" key={option.value}>
            <input
              type="radio"
              id={id}
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span>
              <label htmlFor={id}>{option.label}</label>
              {option.description ? (
                <p className="cdfir-field__hint">{option.description}</p>
              ) : null}
            </span>
          </div>
        );
      })}
      {error ? (
        <p className="cdfir-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
