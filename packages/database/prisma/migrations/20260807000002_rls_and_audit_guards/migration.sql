-- Row-level security for every tenant-owned table, append-only audit guards,
-- and worker/platform access policies.
--
-- The runtime application role (see sql/roles.sql) is NOT the table owner and
-- has NOBYPASSRLS, so these policies apply to all application queries.
-- Tenant context is established per transaction with
--   SELECT set_config('app.tenant_id', $1, true)
-- (see packages/database/src/client.ts). A missing setting yields NULL and
-- therefore zero visible rows: fail closed.

-- ---------------------------------------------------------------------------
-- Tenant isolation on all tenant-owned tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','role_assignments',
    'connector_accounts','connector_secrets','connector_scopes','custodians',
    'collections','collection_custodians','collection_checkpoints',
    'collection_items','collection_exceptions','job_attempts',
    'evidence_blobs','evidence_items','evidence_versions',
    'evidence_relationships','email_metadata','email_participants','headers',
    'drive_metadata','extracted_texts','ocr_pages','previews','malware_scans',
    'tags','tag_assignments','tag_notes','saved_searches',
    'cases','case_members','case_items','case_notes',
    'redactions','annotations',
    'exports','export_items',
    'productions','production_selections','production_profiles',
    'production_runs','production_items','production_exceptions',
    'bates_reservations',
    'retention_policies','deletion_requests',
    'audit_events','outbox_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING ("tenantId" = current_setting(''app.tenant_id'', true)::uuid) '
      || 'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- tenants table: a session sees only its own tenant row; platform context
-- (operator console, migrations tooling) may enumerate tenants but gains no
-- access to evidence tables through it.
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "tenants"
  USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_platform ON "tenants"
  USING (current_setting('app.platform', true) = 'true');
-- Platform context may create tenants (onboarding).
CREATE POLICY tenant_platform_insert ON "tenants"
  FOR INSERT
  WITH CHECK (current_setting('app.platform', true) = 'true');

-- ---------------------------------------------------------------------------
-- Login-time self lookups: a just-authenticated user needs their own
-- memberships and roles across tenants before any tenant context exists.
-- app.user_id is set only by the auth layer for exactly these reads.
-- ---------------------------------------------------------------------------
CREATE POLICY self_memberships ON "memberships"
  FOR SELECT
  USING ("userId" = current_setting('app.user_id', true)::uuid);

CREATE POLICY self_role_assignments ON "role_assignments"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m.id = "role_assignments"."membershipId"
        AND m."userId" = current_setting('app.user_id', true)::uuid
    )
  );

-- Users may read tenant rows they hold a membership in (tenant picker).
CREATE POLICY tenant_member_select ON "tenants"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m."tenantId" = "tenants".id
        AND m."userId" = current_setting('app.user_id', true)::uuid
    )
  );

-- ---------------------------------------------------------------------------
-- Outbox dispatcher: the worker's dispatcher polls pending events across
-- tenants (payloads re-enter tenant scope before any data access).
-- app.worker is set only by the worker's outbox loop.
-- ---------------------------------------------------------------------------
CREATE POLICY worker_outbox ON "outbox_events"
  USING (current_setting('app.worker', true) = 'true')
  WITH CHECK (current_setting('app.worker', true) = 'true');

-- Platform context may read audit events for operational verification, but
-- receives no equivalent policy on any evidence-bearing table.
CREATE POLICY platform_audit_select ON "audit_events"
  FOR SELECT
  USING (current_setting('app.platform', true) = 'true');

-- ---------------------------------------------------------------------------
-- Append-only audit log: block UPDATE/DELETE at trigger level in addition to
-- role grants, so even the table owner cannot rewrite history in place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_events_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

-- Evidence blobs are immutable once written: no UPDATE of key fields.
CREATE OR REPLACE FUNCTION evidence_blobs_block_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."objectKey" IS DISTINCT FROM OLD."objectKey"
     OR NEW."size" IS DISTINCT FROM OLD."size" THEN
    RAISE EXCEPTION 'evidence_blobs content identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_blobs_immutable
  BEFORE UPDATE ON "evidence_blobs"
  FOR EACH ROW EXECUTE FUNCTION evidence_blobs_block_rewrite();
