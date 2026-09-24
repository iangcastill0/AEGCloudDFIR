'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Notice, TextInput } from '@aeg-clouddfir/ui';
import { useJoinTenant, useMe } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';

function tokenFromWindow(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export default function JoinPage() {
  const me = useMe();
  const join = useJoinTenant();
  const [token, setToken] = useState('');
  const [autoTried, setAutoTried] = useState(false);
  const mutate = join.mutate;
  const joinPending = join.isPending;
  const joinSuccess = join.isSuccess;

  useEffect(() => {
    const fromUrl = tokenFromWindow();
    if (fromUrl) setToken(fromUrl);
  }, []);

  useEffect(() => {
    if (autoTried || !token || me.isPending || !me.data || joinPending || joinSuccess) {
      return;
    }
    if (tokenFromWindow()) {
      setAutoTried(true);
      mutate(token, { onSuccess: () => window.location.assign('/') });
    }
  }, [autoTried, token, me.isPending, me.data, joinPending, joinSuccess, mutate]);

  return (
    <>
      <h1>Join an organization</h1>
      <p>
        Open the link from that organization. Sign up or sign in first if you have not yet. You will
        come back here and join.
      </p>

      {join.isSuccess ? (
        <Notice variant="info">Joined {join.data.name}. Opening the workspace…</Notice>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            join.mutate(token, { onSuccess: () => window.location.assign('/') });
          }}
        >
          <TextInput
            label="Invite token"
            hint="If you opened the organization link, this is filled in for you."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
          />
          {join.isError ? (
            <p role="alert" className="cdfir-field__error">
              {errorMessage(join.error)}
            </p>
          ) : null}
          <Button type="submit" busy={join.isPending} disabled={!token || me.isPending}>
            Join
          </Button>
        </form>
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/auth/tenant">Back to tenants</Link>
      </p>
    </>
  );
}
