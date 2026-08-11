import type { ReactNode } from 'react';

/** Renders content available to assistive technology but not visually. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="ev-visually-hidden">{children}</span>;
}
