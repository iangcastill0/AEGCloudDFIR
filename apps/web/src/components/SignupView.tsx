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
  const [token, setToken] = useState('');
  // URL token is read in an effect (window is unavailable during SSR). Until
  // that runs, a cached `me` must not redirect — otherwise /signup?token=…
  // for a signed-in user loses the invite and never calls /auth/join.
  const [tokenReady, setTokenReady] = useState(false);
  const [autoTried, setAutoTried] = useState(false);
  const mutate = join.mutate;
  const joinPending = join.isPending;
  const joinSuccess = join.isSuccess;

  useEffect(() => {
    setToken(tokenFromWindow());
    setTokenReady(true);
  }, []);

  useEffect(() => {
    if (!tokenReady || !me.data || token) return;
    window.location.assign(me.data.tenant ? '/' : '/auth/tenant');
  }, [tokenReady, me.data, token]);

  useEffect(() => {
    if (
      !tokenReady ||
      autoTried ||
      !token ||
      me.isPending ||
      !me.data ||
      joinPending ||
      joinSuccess
    ) {
      return;
    }
    setAutoTried(true);
    mutate(token, { onSuccess: () => window.location.assign('/') });
  }, [tokenReady, autoTried, token, me.isPending, me.data, joinPending, joinSuccess, mutate]);

  if (me.isPending) {
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
