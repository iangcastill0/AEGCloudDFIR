'use client';
import type { CSSProperties, ReactNode } from 'react';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="cdfir-empty">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
}: ErrorStateProps) {
  return (
    <div className="cdfir-error-state" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="cdfir-button cdfir-button--secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export interface SkeletonProps {
  /** Screen-reader announcement; defaults to "Loading". */
  label?: string;
  lines?: number;
  style?: CSSProperties;
}

export function Skeleton({ label = 'Loading', lines = 3, style }: SkeletonProps) {
  return (
    <div>
      <VisuallyHidden>{label}…</VisuallyHidden>
      <div aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="cdfir-skeleton"
            style={{ marginBlock: 'var(--space-2)', width: i % 2 === 0 ? '100%' : '75%', ...style }}
          />
        ))}
      </div>
    </div>
  );
}
