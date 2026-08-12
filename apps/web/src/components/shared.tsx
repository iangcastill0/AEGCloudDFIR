'use client';
/** Small shared building blocks used across routes. */
import { useState, type ReactNode } from 'react';
import { Button, Dialog, ErrorState, Notice, Skeleton, TextInput } from '@aeg-clouddfir/ui';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import { errorMessage } from '@/lib/errors';
import { humanizeToken } from '@/lib/format';
import { parseHighlight } from '@/lib/highlight';

/** Contextual truthfulness notice (contract §20). */
export function TruthNotice({
  kind,
  variant = 'info',
}: {
  kind: keyof typeof TRUTHFULNESS_NOTICES;
  variant?: 'info' | 'warning';
}) {
  return <Notice variant={variant}>{TRUTHFULNESS_NOTICES[kind]}</Notice>;
}

/** Status pill: color + text, never color alone. */
export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'completed' ||
    status === 'ready' ||
    status === 'released' ||
    status === 'complete_within_selected_api_scope'
      ? 'good'
      : status === 'failed' || status === 'cancelled' || status === 'cancelling'
        ? 'bad'
        : status === 'paused' || status === 'complete_with_exceptions' || status === 'partial'
          ? 'warn'
          : 'active';
  return <span className={`pill pill--${tone}`}>{humanizeToken(status)}</span>;
}

/** Confirmation dialog with optional required reason text. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  requireReason?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      actions={
        <>
          <Button variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant={props.destructive ? 'danger' : 'primary'}
            busy={props.busy}
            disabled={props.requireReason ? reason.trim().length === 0 : false}
            onClick={() => props.onConfirm(reason.trim())}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <div>{props.body}</div>
      {props.requireReason ? (
        <TextInput
          label="Reason (recorded in the audit log)"
          value={reason}
          required
          onChange={(e) => setReason(e.target.value)}
        />
      ) : null}
    </Dialog>
  );
}

/** Standard data-fetch wrapper: loading skeleton, error with retry, empty. */
export function QueryBoundary<T>(props: {
  isPending: boolean;
  error: unknown;
  data: T | undefined;
  onRetry: () => void;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (props.isPending) return <Skeleton label={props.loadingLabel ?? 'Loading'} />;
  if (props.error !== null && props.error !== undefined)
    return <ErrorState message={errorMessage(props.error)} onRetry={props.onRetry} />;
  if (props.data === undefined)
    return <ErrorState message="No data returned." onRetry={props.onRetry} />;
  return <>{props.children(props.data)}</>;
}

/** Renders a highlight snippet: only <mark>…</mark> tokens become <mark>. */
export function HighlightText({ snippet }: { snippet: string }) {
  return (
    <>
      {parseHighlight(snippet).map((segment, i) =>
        segment.marked ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
      )}
    </>
  );
}
