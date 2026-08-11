import type { ReactNode, TableHTMLAttributes } from 'react';

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Accessible description of the table contents. */
  caption: string;
  /** Hide the caption visually while keeping it for assistive tech. */
  captionHidden?: boolean;
  children: ReactNode;
}

export function Table({ caption, captionHidden = false, children, ...rest }: TableProps) {
  return (
    <div className="ev-table-wrap">
      <table className="ev-table" {...rest}>
        <caption className={captionHidden ? 'ev-visually-hidden' : undefined}>{caption}</caption>
        {children}
      </table>
    </div>
  );
}
