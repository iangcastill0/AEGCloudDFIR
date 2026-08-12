'use client';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
  /** Shows a busy indicator and sets aria-busy; the button stays focusable. */
  busy?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  small = false,
  busy = false,
  type = 'button',
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = ['cdfir-button', `cdfir-button--${variant}`];
  if (small) classes.push('cdfir-button--small');
  if (className) classes.push(className);
  return (
    <button
      type={type}
      className={classes.join(' ')}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <span aria-hidden="true">…</span> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name — required because the visible content is iconic. */
  label: string;
  children: ReactNode;
}

export function IconButton({
  label,
  type = 'button',
  className,
  children,
  ...rest
}: IconButtonProps) {
  const classes = ['cdfir-icon-button'];
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} aria-label={label} title={label} {...rest}>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}
