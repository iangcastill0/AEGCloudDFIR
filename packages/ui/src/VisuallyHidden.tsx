import type { ReactNode } from 'react';

/** Renders content available to assistive technology but not visually. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="cdfir-visually-hidden">{children}</span>;
}
