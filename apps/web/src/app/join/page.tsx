'use client';
import { useEffect } from 'react';

/** Old invite URLs used /join. Send them to the public sign-up page. */
export default function JoinRedirectPage() {
  useEffect(() => {
    window.location.replace(`/signup${window.location.search}`);
  }, []);
  return (
    <p role="status" aria-live="polite">
      Opening sign-up…
    </p>
  );
}
