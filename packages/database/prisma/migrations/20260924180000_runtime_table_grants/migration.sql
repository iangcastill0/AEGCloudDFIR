-- Repair runtime grants for tables created while migrations were run as
-- postgres instead of cdfir_migrator.
--
-- The normal role bootstrap grants default privileges for cdfir_migrator.
-- PostgreSQL default privileges are per creating role, so they do not apply
-- when an operator runs a migration as postgres. The tables then exist and RLS
-- is enabled, but the cdfir runtime role gets "permission denied" before RLS
-- can even evaluate its tenant policy.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "export_parts",
  "tenant_invites",
  "forensic_imports",
  "import_artifacts",
  "import_cases"
TO cdfir;

-- Make future manual migrations by whichever role applies this migration grant
-- the same runtime permissions. Correct deployments still use cdfir_migrator;
-- this closes the foot-gun without weakening RLS or audit append-only guards.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cdfir;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cdfir;
