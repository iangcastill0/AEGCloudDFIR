# THREAT MODEL — AEG-CloudDFIR

Scope: the AEG-CloudDFIR application (web, api, worker), its data stores
(PostgreSQL, OpenSearch, Redis, S3/Wasabi), its identity dependencies
(Authentik, Microsoft identity platform, Google OAuth), and the evidence
lifecycle from acquisition to production. Methodology: STRIDE per component +
abuse cases specific to eDiscovery.

## Assets

- **A1. Original evidence bytes** (emails, files) — confidentiality and
  integrity are paramount; availability matters but never at integrity's cost.
- **A2. Provider credentials** — OAuth refresh tokens, service-account keys
  with domain-wide delegation (the single most dangerous secret in the system).
- **A3. Chain-of-custody records** — audit events, manifests, hash chains.
- **A4. Review work product** — tags, privilege designations, redactions,
  notes (often themselves privileged material).
- **A5. Productions** — released document sets; an incorrect production leaks
  privileged/redacted content irreversibly.
- **A6. Tenant boundary** — one installation serves adverse parties in
  unrelated matters.

## Trust boundaries

1. Browser ↔ API (public network)
2. API/Worker ↔ PostgreSQL/Redis/OpenSearch/S3 (service network)
3. Worker ↔ provider APIs (egress to internet)
4. Worker ↔ hostile file content (parsers, OCR, office conversion)
5. Platform operator ↔ tenant data
6. AEG-CloudDFIR ↔ Authentik

## Threats and mitigations

### Spoofing

| Threat                               | Mitigation                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Forged login / token replay          | OIDC code+PKCE; validate iss, aud, sig, exp, nonce, state; short session lifetime; `__Host-` cookies, SameSite=Lax, Secure |
| Forged OAuth callback for connectors | per-connect `state` bound to session + tenant, one-time use, 10-min TTL                                                    |
| Spoofed webhook/job injection        | no unauthenticated ingest endpoints; jobs originate only from the transactional outbox                                     |
| IdP substitution                     | issuer pinned in config; JWKS fetched from discovery, cached with kid rotation handling                                    |

### Tampering

| Threat                              | Mitigation                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence mutation after acquisition | content-addressed keys (`originals/sha256/...`); app never issues overwrite/delete on originals; optional Object Lock; hash re-verification on export/production |
| Audit log rewrite                   | append-only table (no UPDATE/DELETE grants; RLS + trigger blocks), SHA-256 hash chain, `audit:verify` CLI recomputes the chain                                   |
| Search index poisoning              | index rebuilt only from PostgreSQL/S3 truth; index writes only from worker service account                                                                       |
| Load-file injection (DAT/OPT/CSV)   | strict escaping, delimiter/quote configuration, formula-injection prefix guard (`'` before `=+-@\t`)                                                             |
| Query injection into OpenSearch     | user query parsed to typed AST → validated fields/operators → compiled server-side; raw query strings never forwarded                                            |

### Repudiation

| Threat                             | Mitigation                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "I never downloaded/produced that" | every auth-z'd action emits an audit event with actor, role, tenant, IP, UA, correlation id, hash-chained |
| Disputed collection scope          | signed collection manifest snapshots scope, endpoints, counts, exceptions, item hashes, Merkle root       |

### Information disclosure

| Threat                                                   | Mitigation                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant read (IDOR)                                 | `tenant_id` on every row; PostgreSQL RLS with per-transaction `SET LOCAL app.tenant_id`; repository layer additionally filters; negative tests for id/search/download/job/export/production routes; 404 (not 403) on foreign ids to avoid existence leakage |
| Presigned URL leakage                                    | short TTL (≤5 min), server-side authorization before minting, keys validated against tenant prefix, URLs never logged                                                                                                                                       |
| Token/secret leakage in logs                             | envelope encryption at rest (AES-256-GCM DEKs wrapped by master KEK via `KeyEncryptionProvider`); structured logger with deny-list redaction (authorization, token, secret, presigned params, raw bodies); tests assert redaction                           |
| Email preview exfiltration (tracking pixels, remote CSS) | previews rendered from sanitized HTML: scripts/forms/remote loads stripped, CSP `default-src 'none'`, images only from same-origin derivative store; external fetch is off and there is no proxy implemented                                                |
| Privileged material in productions                       | validation blocks natives for redacted items and flags privileged families; security-critical overrides need elevated permission + second confirmation + audit                                                                                              |
| Platform operator snooping                               | `platform_admin` has no evidence-read routes; content access requires break-glass workflow (disabled by default, fully audited design in runbook)                                                                                                           |
| SSRF from user-supplied URLs / provider redirects        | egress allowlist per connector (graph.microsoft.com, login.microsoftonline.com, gmail/googleapis.com, oauth2.googleapis.com); no user-controlled fetch targets; redirects validated against allowlist                                                       |

### Denial of service

| Threat                                          | Mitigation                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Archive bombs / decompression attacks           | depth ≤ 3, expansion ratio caps, absolute output caps, per-entry and total limits; violations become processing exceptions |
| Pathological documents (OCR/convert)            | sandboxed worker containers, CPU/memory/time/page limits, non-root read-only FS, no network for parser containers          |
| Expensive search (leading wildcards, huge slop) | AST cost model: wildcard min prefix length, clause caps, slop caps, result window caps, per-tenant rate limits             |
| Queue flooding                                  | per-tenant/provider/account concurrency limits; quotas on concurrent collections/exports/productions                       |
| Large uploads/downloads exhausting memory       | everything streams; no full-file buffering anywhere in the pipeline                                                        |

### Elevation of privilege

| Threat                                         | Mitigation                                                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role tampering                                 | roles resolved server-side per request from DB/claims; never trusted from client; route guards + service-layer checks (defense in depth)                                                                   |
| Connector scope creep                          | least-privilege read-only scopes pinned in code; org-mode setup guides document tenant-side scoping (application access policies, DWD scope allowlists); app validates granted scopes against expected set |
| Malicious file → worker RCE → credential theft | parsers in locked-down containers without secrets; workers fetch per-job scoped credentials; service-account keys decrypted only in the connector process, held only in memory                             |
| CSRF on state-changing routes                  | SameSite cookies + double-submit CSRF token on cookie-authenticated routes; Origin checks; idempotency keys                                                                                                |

## eDiscovery-specific abuse cases

1. **Adverse party in same installation subpoenas the other's data** — tenant
   isolation (RLS + prefix separation in S3 + per-tenant OpenSearch filter
   injection) is the control; verified by adversarial tests.
2. **Reviewer exports privileged docs before privilege review completes** —
   case-level permissions gate export creation and download; privileged-tag
   filters are enforced server-side; all exports audited.
3. **Operator quietly deletes inconvenient evidence** — originals are
   content-addressed and append-only; deletion is two-phase, hold-blocked,
   audited, and produces a deletion manifest; Object Lock (when enabled)
   removes even operator capability.
4. **Fabricated completeness claims** — completeness states are constrained to
   the five defined values; manifests record provider-reported totals
   separately from observed counts; UI never renders an unqualified
   "complete".
5. **Bates collision across concurrent productions** — `BatesReservation`
   rows reserve ranges atomically (serializable transaction + unique
   constraint), so two runs can never stamp the same number.

## Residual risks (accepted, documented)

- A compromised Authentik instance compromises login integrity; mitigate
  operationally (Authentik hardening runbook).
- Wasabi/S3 operator with root credentials can bypass application controls
  unless Object Lock compliance mode is enabled.
- OCR quality limits search recall on scanned documents; confidence is stored
  and surfaced but low-confidence text can still miss terms.
- Provider APIs may omit data invisibly (e.g., items purged before
  acquisition); manifests state scope honestly but cannot enumerate what the
  API never returned.
