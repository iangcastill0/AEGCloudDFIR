'use client';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface StepperProps {
  label: string;
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
  /** When provided, completed steps become buttons that jump back. */
  onStepSelect?: (index: number) => void;
}

/** Wizard progress indicator with aria-current="step". */
export function Stepper({ label, steps, current, onStepSelect }: StepperProps) {
  return (
    <nav aria-label={label}>
      <ol className="ev-stepper">
        {steps.map((step, index) => {
          const done = index < current;
          const isCurrent = index === current;
          const content = (
            <>
              <span aria-hidden="true">{done ? '✓' : index + 1}</span>
              {step}
              {done ? <VisuallyHidden>(completed)</VisuallyHidden> : null}
            </>
          );
          return (
            <li
              key={step}
              className={done ? 'ev-stepper__step ev-stepper__step--done' : 'ev-stepper__step'}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {done && onStepSelect ? (
                <button
                  type="button"
                  className="ev-button ev-button--ghost ev-button--small"
                  onClick={() => onStepSelect(index)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
