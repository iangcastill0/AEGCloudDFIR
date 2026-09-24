-- Self-serve tenancy: billing hook on tenants, plus app-side invites.
--
-- billingStatus / billingCustomerId are unused by a paywall yet. They exist so
-- a later Stripe (or similar) integration does not need another tenant-table
-- migration. Write routes must not read them until that guard is written.
--
-- tenant_invites is the join path for an existing org. It is not an Authentik
-- enrollment invitation: those decide who may create an IdP account. Anyone
-- may create an IdP account; this table decides who may join a tenant.

CREATE TYPE "BillingStatus" AS ENUM ('none', 'trial', 'active', 'past_due', 'canceled');

ALTER TABLE "tenants"
  ADD COLUMN "billingStatus" "BillingStatus" NOT NULL DEFAULT 'none',
  ADD COLUMN "billingCustomerId" TEXT,
  ADD COLUMN "joinToken" TEXT;

CREATE UNIQUE INDEX "tenants_joinToken_key" ON "tenants"("joinToken");

-- Redeem of the standing org link: the caller is logged in but has no tenant
-- yet. Auth sets app.join_token to the raw secret for exactly this SELECT.
CREATE POLICY join_token_lookup ON "tenants"
  FOR SELECT
  USING ("joinToken" = NULLIF(current_setting('app.join_token', true), ''));

CREATE TABLE "tenant_invites" (
  "id"              UUID NOT NULL,
  "tenantId"        UUID NOT NULL,
  "email"           TEXT NOT NULL,
  "role"            "TenantRole" NOT NULL,
  "tokenHash"       TEXT NOT NULL,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "createdByUserId" UUID NOT NULL,
  "usedAt"          TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_invites_tokenHash_key" ON "tenant_invites"("tokenHash");
CREATE INDEX "tenant_invites_tenantId_idx" ON "tenant_invites"("tenantId");
CREATE INDEX "tenant_invites_email_idx" ON "tenant_invites"("email");

ALTER TABLE "tenant_invites"
  ADD CONSTRAINT "tenant_invites_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tenant_invites"
  ADD CONSTRAINT "tenant_invites_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation lives in the database. FORCE so the table owner is bound
-- too; without FORCE, a missing withTenantContext would leak silently.
ALTER TABLE "tenant_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_invites"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Redeem path: the caller is logged in but has no tenant on the session yet.
-- Auth sets app.invite_token_hash for exactly this SELECT, then switches to
-- tenant context to create the membership and mark the row used.
CREATE POLICY invite_token_lookup ON "tenant_invites"
  FOR SELECT
  USING ("tokenHash" = NULLIF(current_setting('app.invite_token_hash', true), ''));
