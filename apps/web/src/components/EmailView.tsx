'use client';
import { Notice } from '@aeg-clouddfir/ui';
import { TruthNotice } from '@/components/shared';
import { emlContextRows, emlHeaderRows, hadHiddenBcc, type EmlSource } from '@/lib/eml-view';

/**
 * An email shown the way an email client shows one: who it was from and to, the
 * subject and date, then the body.
 *
 * The body itself is unchanged from the plain preview — the same sandboxed frame
 * for sanitized HTML, the same preformatted block for text. Only the header
 * block above it is new. Every rule about WHICH lines appear lives in
 * lib/eml-view.ts, which is tested without a browser.
 */
export function EmailView({
  item,
  attachments,
  body,
  onOpenAttachment,
}: {
  item: EmlSource;
  attachments: { id: string; name: string; kind: string }[];
  body: React.ReactNode;
  onOpenAttachment: (id: string) => void;
}) {
  const rows = emlHeaderRows(item);
  const context = emlContextRows(item);

  return (
    <div className="eml">
      <dl className="eml-header">
        {rows.map((row) => (
          <div className="eml-header__row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {attachments.length > 0 ? (
        <div className="eml-attachments">
          <span className="eml-attachments__label">
            {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
          </span>
          {attachments.map((a) => (
            <button
              key={a.id}
              type="button"
              className="cdfir-button cdfir-button--ghost cdfir-button--small"
              onClick={() => onOpenAttachment(a.id)}
            >
              📎 {a.name}
            </button>
          ))}
        </div>
      ) : null}

      {hadHiddenBcc(item) ? (
        <>
          <Notice variant="warning">
            This message had a bcc. The stored copy does not name who was on it.
          </Notice>
          <TruthNotice kind="bcc" />
        </>
      ) : null}

      <div className="eml-body">{body}</div>

      {context.length > 0 ? (
        <dl className="eml-header eml-header--context">
          {context.map((row) => (
            <div className="eml-header__row" key={row.label}>
              <dt>{row.label}</dt>
              <dd className="mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
