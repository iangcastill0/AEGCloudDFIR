# ADR-014: Identity in Authentik, tenancy in the app

Status: accepted · Date: 2026-09-22

## Context

Login already uses Authentik as the only identity provider (ADR-009). There was
no public sign-up. An operator created the Authentik user and then granted the
first tenant admin with a CLI that needs database credentials. That rule exists
so the first person to reach a freshly deployed server cannot own the platform.

A SaaS door needs people to create their own account and their own organization
without an operator in the middle. Those are two different jobs. Mixing them
would either put tenant membership in Authentik groups (wrong for many
customers on one IdP) or put passwords in our database (forbidden by ADR-009).

## Decision

**Authentik answers “who is this person?”** Public enrollment (`cdfir-enrollment`)
collects email, name, and password, then requires a TOTP app. There is no
confirmation mail. The existing OIDC code + PKCE callback still upserts `User`
on `(issuer, subject)`. No local passwords. MFA is an IdP policy (TOTP at
sign-up and on every later sign-in). We do not call Authentik’s admin API to
create users.

**The app answers “which organization do they work in?”** After login, a person
with no memberships can create a tenant (`POST /api/v1/tenants`, behind
`CDFIR_SELF_SERVE_SIGNUP`) and becomes that tenant’s `org_admin`, or redeem a
standing org join link (`POST /auth/join`). Each tenant has one standing
`joinToken`, shown on Members. That URL is `{WEB}/signup?token=…` and opens
the public sign-up page. After they create an account (or sign in), they are
added as a reviewer. One-time email invites still exist as a secondary path.
Bootstrap CLI remains the way to grant the first **platform** administrator
and to recover an instance that has lost its last admin.

The old “no first user becomes admin” rule still applies to the **server**. It
does not apply to a new customer’s own tenant.

`Tenant.billingStatus` and `Tenant.billingCustomerId` are a hook for a later
paywall. Write routes do not read them yet.

## Consequences

- Enabling public enrollment on Authentik lets anyone create an IdP account.
  They still cannot see evidence until they create or join a tenant.
- Sign-up does not need SMTP. TOTP is the second check. SMTP is optional for
  password recovery only.
- The standing join link is a secret. Anyone who has it can join as a reviewer.
  Rotate it on Members if it leaks. One-time email invites still match the
  signed-in address.
- Auto-join by email domain is out of scope. An unverified `@company.com`
  mailbox must not walk into an evidence tenant.
