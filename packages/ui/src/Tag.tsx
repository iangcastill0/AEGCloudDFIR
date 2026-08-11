'use client';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface TagProps {
  name: string;
  /** Hex color rendered as a swatch. Meaning is always carried by the text. */
  color: string;
  privileged?: boolean;
  confidential?: boolean;
  onRemove?: () => void;
}

/** Tag chip: color swatch plus a text label so color is never the only cue. */
export function Tag({ name, color, privileged, confidential, onRemove }: TagProps) {
  return (
    <span className="ev-tag">
      <span className="ev-tag__swatch" style={{ backgroundColor: color }} aria-hidden="true" />
      <span>
        {name}
        {privileged ? ' · privileged' : ''}
        {confidential ? ' · confidential' : ''}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="ev-button ev-button--ghost ev-button--small"
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
          <VisuallyHidden>Remove tag {name}</VisuallyHidden>
        </button>
      ) : null}
    </span>
  );
}
