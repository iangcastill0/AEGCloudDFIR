import type { ReactNode } from 'react';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface NoticeProps {
  variant?: 'info' | 'warning';
  title?: string;
  children: ReactNode;
}

/**
 * Inline informational note (role=note). Used for the standing truthfulness
 * notices required by the contract; variant conveys tone with icon + text,
 * never color alone.
 */
export function Notice({ variant = 'info', title, children }: NoticeProps) {
  return (
    <div role="note" className={`cdfir-notice cdfir-notice--${variant}`}>
      <span className="cdfir-notice__icon" aria-hidden="true">
        {variant === 'warning' ? '⚠' : 'ⓘ'}
      </span>
      <div>
        <VisuallyHidden>{variant === 'warning' ? 'Warning:' : 'Note:'}</VisuallyHidden>
        {title ? <strong>{title} — </strong> : null}
        {children}
      </div>
    </div>
  );
}
