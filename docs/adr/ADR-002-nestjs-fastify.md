# ADR-002: NestJS on Fastify for api and worker

Status: accepted · Date: 2026-08-07

## Context

The api is an OIDC relying party + resource server with strict security
middleware; the worker hosts BullMQ processors. Both need DI, testability,
and structured module boundaries.

## Decision

NestJS 11 with the Fastify adapter for the api (throughput, schema-based
validation, @fastify/helmet, @fastify/cookie). The worker is a NestJS
standalone application context hosting BullMQ processors — no HTTP surface
except health/metrics.

## Consequences

Uniform DI/testing across api and worker. Fastify plugins cover secure
headers, cookies, CSRF, rate limits. Express-specific middleware is avoided.
