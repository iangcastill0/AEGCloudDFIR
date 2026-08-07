# ADR-003: PostgreSQL 16 + Prisma with row-level security

Status: accepted · Date: 2026-08-07

## Context

Every tenant-owned row must carry tenant_id and isolation must hold even if
application code has a bug (defense in depth).

## Decision

Prisma for schema/migrations. All tenant tables get RLS policies comparing
tenant_id to current_setting('app.tenant_id')::uuid. The runtime database
role is NOT BYPASSRLS; migrations run under a separate owner role. Repository
helpers open every transaction with SET LOCAL app.tenant_id and refuse to run
without tenant context. Audit tables additionally revoke UPDATE/DELETE and
carry a BEFORE trigger that raises on modification.

## Consequences

Two DATABASE_URLs (runtime, migrator). Cross-tenant negative tests exercise
both the repository layer and raw SQL under the runtime role.
