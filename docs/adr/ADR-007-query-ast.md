# ADR-007: Search queries compile through a typed AST

Status: accepted · Date: 2026-08-07

## Context

User query strings must never reach OpenSearch raw (injection, cost abuse,
tenant bypass).

## Decision

A tokenizer/parser produces a typed AST (phrase, term, wildcard, fuzzy,
proximity, boolean, fielded, range). Validation checks fields against the
mapping registry, enforces wildcard prefix length, clause count, slop and
window caps. The compiler wraps every query in filter context with tenant_id
and case ACL terms injected server-side. The visual builder emits the same AST.

## Consequences

One choke point for authorization and cost control; adversarial tests target
the parser/compiler directly.
