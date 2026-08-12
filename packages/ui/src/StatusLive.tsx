'use client';
import type { ReactNode } from 'react';

export interface StatusLiveProps {
  /** 'polite' for routine async status, 'assertive' for urgent errors. */
  politeness?: 'polite' | 'assertive';
  children: ReactNode;
}

/**
 * Visually-integrated live region for async status text. Keep the element
 * mounted and swap its text content so screen readers announce changes.
 */
export function StatusLive({ politeness = 'polite', children }: StatusLiveProps) {
  return (
    <div role="status" aria-live={politeness} aria-atomic="true">
      {children}
    </div>
  );
}

export interface ToastMessage {
  id: string;
  text: string;
  tone?: 'info' | 'error';
}

export interface ToastRegionProps {
  messages: ToastMessage[];
  onDismiss: (id: string) => void;
}

/** Toast stack announced politely; error toasts additionally role=alert. */
export function ToastRegion({ messages, onDismiss }: ToastRegionProps) {
  return (
    <div className="cdfir-toast-region" role="region" aria-live="polite" aria-label="Notifications">
      {messages.map((message) => (
        <div
          key={message.id}
          className={message.tone === 'error' ? 'cdfir-toast cdfir-toast--error' : 'cdfir-toast'}
          role={message.tone === 'error' ? 'alert' : undefined}
        >
          <span>{message.text}</span>
          <button
            type="button"
            className="cdfir-button cdfir-button--ghost cdfir-button--small"
            onClick={() => onDismiss(message.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
