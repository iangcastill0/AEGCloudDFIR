# ADR-010: Hash-chained append-only audit log

Status: accepted · Date: 2026-08-07

## Context

Chain-of-custody requires tamper-evident, append-only auditing with a
verification command.

## Decision

audit_events is append-only (grants + trigger). Each event stores
prev_event_hash and event_hash = SHA-256(prev_event_hash ||
canonical_json(event_without_hash)) with RFC 8785-style key-sorted
canonicalization. Chains are per-tenant with sequence numbers; inserts take a
per-tenant advisory lock to serialize the chain head. scripts/audit-verify.ts
recomputes the full chain and reports the first divergence.

## Consequences

Tampering with any historical row invalidates all later hashes. Verification
is O(n) and runnable offline from a database dump.
