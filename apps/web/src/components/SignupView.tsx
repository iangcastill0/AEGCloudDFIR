'use client';
import { useEffect, useState } from 'react';
import { Notice } from '@aeg-clouddfir/ui';
import { loginUrl } from '@/lib/api';
import { useJoinTenant, useMe } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

function tokenFromWindow(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function SignupView() {
  const me = useMe();
  const join = useJoinTenant();
  // null until the URL is read. Starting at '' made a logged-in visitor
  // bounce to / or /auth/tenant before the token was seen, so an invite
  // never joined them to the org that sent the link.
  const [token, setToken] = useState<string | null>(null);
  const [autoTried, setAutoTried] = useState(false);
  const mutate = join.mutate;
  const joinPending = join.isPending;
  const joinSuccess = join.isSuccess;

  useEffect(() => {
    setToken(tokenFromWindow());
  }, []);

  useEffect(() => {
    if (token === null || !me.data || token) return;
    window.location.assign(me.data.tenant ? '/' : '/auth/tenant');
  }, [me.data, token]);

  useEffect(() => {
    if (autoTried || !token || me.isPending || !me.data || joinPending || joinSuccess) {
      return;
    }
    setAutoTried(true);
    mutate(token, { onSuccess: () => window.location.assign('/') });
  }, [autoTried, token, me.isPending, me.data, joinPending, joinSuccess, mutate]);

  if (me.isPending || token === null) {
    return (
      <p role="status" aria-live="polite">
        Loading…
      </p>
    );
  }

  if (me.data && token) {
    return (
      <>
        <h1>Join this organization</h1>
        {join.isSuccess ? (
          <Notice variant="info">Joined {join.data.name}. Opening the workspace…</Notice>
        ) : join.isError ? (
          <p role="alert" className="cdfir-field__error">
            {errorMessage(join.error)}
          </p>
        ) : (
          <p>Adding you to the organization…</p>
        )}
      </>
    );
  }

  if (me.data) {
    return (
      <p role="status" aria-live="polite">
        Opening your workspace…
      </p>
    );
  }

  const next = token ? `/signup?token=${encodeURIComponent(token)}` : '/signup';

  return (
    <section className="signup-panel">
      <h1>{token ? 'You are invited' : 'Create your account'}</h1>
      {token ? (
        <p>
          Create an account to join this organization. If you already have one, sign in. You will
          come back here and join automatically.
        </p>
      ) : (
        <p>Create an account to start your own organization, or sign in if you already have one.</p>
      )}
      <div className="button-row">
        <a className="cdfir-button cdfir-button--primary" href={loginUrl(next)}>
          Create account
        </a>
        <a className="cdfir-button cdfir-button--secondary" href={loginUrl(next)}>
          Sign in
        </a>
      </div>
    </section>
  );
}
