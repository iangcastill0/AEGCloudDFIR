'use client';
import { ErrorState } from '@evidencevault/ui';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState message={error.message || 'An unexpected error occurred.'} onRetry={reset} />;
}
