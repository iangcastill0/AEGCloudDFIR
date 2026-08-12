'use client';
import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { FOCUSABLE_SELECTOR, trapTargetIndex } from './focus.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Rendered right-aligned below the content, e.g. Cancel / Confirm buttons. */
  actions?: ReactNode;
}

/**
 * Modal dialog: aria-modal, labelled by its title, focus trapped, Esc and
 * overlay click close it, and focus returns to the opener on close.
 */
export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus();
    }
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const activeIndex = focusables.findIndex((el) => el === document.activeElement);
    const target = trapTargetIndex(activeIndex, focusables.length, event.shiftKey);
    if (target !== null) {
      event.preventDefault();
      focusables[target]?.focus();
    }
  }

  function onOverlayMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="cdfir-dialog-overlay" onMouseDown={onOverlayMouseDown}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="cdfir-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 className="cdfir-dialog__title" id={titleId}>
          {title}
        </h2>
        {children}
        {actions ? <div className="cdfir-dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
