'use client';
import { useId, useState } from 'react';
import { Button, TextInput } from '@aeg-clouddfir/ui';
import { useJoinLink, useRotateJoinLink } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

export function SignupLinkPanel({
  tenantId,
  heading = 'Sign-up link',
}: {
  tenantId: string;
  heading?: string;
}) {
  const headingId = useId();
  const fieldId = useId();
  const joinLink = useJoinLink(tenantId);
  const rotate = useRotateJoinLink(tenantId);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = joinLink.data?.inviteUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      const field = document.getElementById(fieldId) as HTMLInputElement | null;
      field?.select();
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <p>
        Copy this link and send it. It opens the sign-up page. Anyone who creates an account (or
        signs in) joins this organization as a reviewer.
      </p>
      {joinLink.isError ? (
        <p role="alert" className="cdfir-field__error">
          {errorMessage(joinLink.error)}
        </p>
      ) : null}
      {joinLink.data ? (
        <>
          <TextInput
            id={fieldId}
            label="Sign-up link"
            readOnly
            value={joinLink.data.inviteUrl}
            onFocus={(e) => e.currentTarget.select()}
            hint="This link does not expire. Rotate it if it leaks."
          />
          <div className="button-row">
            <Button type="button" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy sign-up link'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={rotate.isPending}
              onClick={() => {
                if (
                  !window.confirm('Rotate this link? The old URL will stop working for everyone.')
                ) {
                  return;
                }
                setCopied(false);
                rotate.mutate();
              }}
            >
              Rotate link
            </Button>
          </div>
          {rotate.isError ? (
            <p role="alert" className="cdfir-field__error">
              {errorMessage(rotate.error)}
            </p>
          ) : null}
        </>
      ) : joinLink.isPending ? (
        <p>Loading sign-up link…</p>
      ) : null}
    </section>
  );
}
