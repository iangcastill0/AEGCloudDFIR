# ADR-006: OpenSearch 2.x behind a SearchAdapter interface

Status: accepted · Date: 2026-08-07

## Context

Forensic search needs full text + structured filters; the engine must be
replaceable per the contract.

## Decision

packages/search defines SearchAdapter (indexBulk, search, facets, reindex,
ensureIndex) and ships the OpenSearch implementation with versioned mappings
(index name includes mapping version; reindex = new index + alias swap).
PostgreSQL + S3 remain the source of truth; the index is disposable.

## Consequences

Engine swap = new adapter. Mapping migrations are explicit and testable.
