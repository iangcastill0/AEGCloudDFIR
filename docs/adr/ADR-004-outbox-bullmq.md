# ADR-004: Transactional outbox over Redis/BullMQ

Status: accepted · Date: 2026-08-07

## Context

Evidence writes and job scheduling must be atomic; Redis alone cannot join a
Postgres transaction. Crashes must never lose or duplicate work.

## Decision

State changes write an OutboxEvent row in the same transaction. A dispatcher
polls (FOR UPDATE SKIP LOCKED), enqueues BullMQ jobs with deterministic jobId
(dedup key), marks rows dispatched. Consumers are idempotent; BullMQ provides
retries with exponential backoff + jitter and a dead-letter queue.

## Consequences

At-least-once delivery with idempotent handlers = effectively-once outcomes.
Redis can be flushed without losing job truth (outbox re-dispatches).
