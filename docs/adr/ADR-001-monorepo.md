# ADR-001: pnpm + Turborepo TypeScript monorepo

Status: accepted · Date: 2026-08-07

## Context

The contract mandates a TypeScript monorepo with three apps and eight shared
packages, one lockfile, pinned dependencies, and CI that gates every change.

## Decision

pnpm workspaces (strict, `save-exact=true`) with Turborepo task orchestration.
Packages build to `dist/` with `tsc`; apps consume workspace packages by name.

## Consequences

Single install, content-addressed store, per-task caching. Turbo's task graph
enforces build order (`^build`). CI runs format/lint/typecheck/test/build on
every push; integration tests run behind the unit gate.
