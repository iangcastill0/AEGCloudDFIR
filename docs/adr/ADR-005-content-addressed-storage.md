# ADR-005: Content-addressed immutable originals in S3/Wasabi

Status: accepted · Date: 2026-08-07

## Context

Originals must be immutable, deduplicated, and verifiable; memory use must be
bounded regardless of item size.

## Decision

Stream to tenants/{t}/staging/{uuid} while computing SHA-256 + size; verify;
copy to tenants/{t}/originals/sha256/{h[0:2]}/{sha256}; delete staging. The
application never overwrites or deletes under originals/ (deletion only via
the governed two-phase workflow). Derivatives live under separate versioned
prefixes. EvidenceBlob rows are unique per (tenant, sha256); logical
EvidenceItems reference blobs, preserving per-custodian provenance.

## Consequences

Byte-level dedup for free; immutability enforced by key scheme + IAM policy +
optional Object Lock (detected and reported, never assumed).
