'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { VisuallyHidden } from '@evidencevault/ui';
import { useLogout, useMe, useSelectTenant } from '@/lib/hooks';
import { API_URL } from '@/lib/api';

const LINKS: Array<{ href: string; label: string; adminOnly?: boolean }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/collections', label: 'Collections' },
  { href: '/review', label: 'Review' },
  { href: '/cases', label: 'Cases' },
  { href: '/exports', label: 'Exports' },
  { href: '/productions', label: 'Productions' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/audit', label: 'Audit' },
  { href: '/admin/members', label: 'Members', adminOnly: true },
  { href: '/auth', label: 'Identity', adminOnly: true },
];

export function AppNav() {
  const pathname = usePathname();
  const me = useMe();
  const selectTenant = useSelectTenant();
  const logout = useLogout();

  const isAdmin = me.data?.roles.includes('org_admin') ?? false;

  function onTenantChange(tenantId: string) {
    if (!tenantId) return;
    selectTenant.mutate(tenantId, {
      onSuccess: () => window.location.assign('/'),
    });
  }

  function onLogout() {
    logout.mutate(undefined, {
      onSuccess: (data) => {
        window.location.assign(data.logoutUrl ?? `${API_URL}/auth/login?redirectTo=%2F`);
      },
    });
  }

  return (
    <header className="app-header">
      <Link href="/" className="app-header__brand">
        EvidenceVault
      </Link>
      <nav className="app-nav" aria-label="Primary">
        <ul>
          {LINKS.filter((l) => !l.adminOnly || isAdmin).map((link) => {
            const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link href={link.href} aria-current={current ? 'page' : undefined}>
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="app-header__session">
        {me.data ? (
          <>
            <label>
              <VisuallyHidden>Active tenant</VisuallyHidden>
              <select
                className="ev-select"
                value={me.data.tenant?.id ?? ''}
                onChange={(e) => onTenantChange(e.target.value)}
                disabled={selectTenant.isPending}
              >
                {me.data.tenant === null ? <option value="">Select tenant…</option> : null}
                {me.data.memberships.map((m) => (
                  <option key={m.tenantId} value={m.tenantId}>
                    {m.tenantName}
                  </option>
                ))}
              </select>
            </label>
            <span>{me.data.user.displayName || me.data.user.email}</span>
            <button
              type="button"
              className="ev-button ev-button--secondary ev-button--small"
              onClick={onLogout}
            >
              Sign out
            </button>
          </>
        ) : me.isPending ? (
          <span role="status" aria-live="polite">
            Loading session…
          </span>
        ) : null}
      </div>
    </header>
  );
}
