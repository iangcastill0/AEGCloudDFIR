# IMPLEMENTATION PLAN — AEG-CloudDFIR

AEG-CloudDFIR is a self-hostable, multi-tenant eDiscovery platform that
collects, preserves, indexes, reviews, tags, exports, and produces email and
cloud-drive evidence from Microsoft 365 / Outlook / OneDrive and
Google Workspace / Gmail / Drive, with Authentik OIDC login and Wasabi/S3
evidence storage.

This plan is the executable version of the build contract. It is organized by
the 13 required milestones; each milestone leaves the repository runnable.
Progress and deviations are recorded in `VERIFICATION.md` at the end.

## 1. Architecture summary

TypeScript monorepo (pnpm workspaces + Turborepo):

| Path                  | Runtime                 | Responsibility                                                                |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `apps/web`            | Next.js 15 (App Router) | Review UI, wizards, admin                                                     |
| `apps/api`            | NestJS 10 + Fastify     | REST API, OIDC resource server + login BFF, presigned URL issuance, authz     |
| `apps/worker`         | NestJS 10 + BullMQ      | Collection, processing, indexing, export, production jobs                     |
| `packages/config`     | lib                     | Zod-validated typed environment configuration                                 |
| `packages/contracts`  | lib                     | Zod DTOs shared web↔api, OpenAPI generation                                   |
| `packages/database`   | lib                     | Prisma schema, migrations, RLS setup SQL, tenant-safe repository helpers      |
| `packages/connectors` | lib                     | Provider adapters (MS Graph, Gmail, Drive), token vault, throttling           |
| `packages/evidence`   | lib                     | Hashing, streaming store, MIME parsing, extraction, preview safety, manifests |
| `packages/search`     | lib                     | OpenSearch mappings, indexer, query AST parser/compiler                       |
| `packages/production` | lib                     | Rendering, stamping, redaction burn-in, Bates, DAT/OPT/CSV writers            |
| `packages/ui`         | lib                     | Shared accessible React components                                            |
| `infra/`              | —                       | docker, compose, kubernetes, authentik blueprint                              |
| `scripts/`            | —                       | audit verify, reindex, SBOM, demo seed                                        |
| `tests/`              | —                       | Playwright E2E, integration harnesses, fixtures                               |

Infrastructure: PostgreSQL 16 (truth), OpenSearch 2.x (rebuildable index behind
a `SearchAdapter`), Redis 7 + BullMQ (queues), MinIO locally / Wasabi in prod
(objects), Authentik (OIDC), ClamAV (scanning), Tika + Tesseract +
LibreOffice headless (extraction; worker container only).

### Core flows

1. **Login**: browser → api `/auth/login` → Authentik (code+PKCE) → api
   validates and establishes an encrypted session cookie; web talks to api
   with that cookie. API also accepts bearer JWTs for programmatic access.
2. **Collection**: wizard → `POST /collections` (idempotency key) → outbox →
   worker discovers folders/labels → per-folder page jobs → stream native to
   staging key while hashing → promote to `originals/sha256/...` → evidence
   row + acquisition audit event + outbox message (transactional) → processing
   jobs (parse → extract → OCR → preview → scan → index) → checkpoint persisted
   only after page durable.
3. **Search**: query string or builder → AST parse → validate → inject
   tenant/case filters → compile to OpenSearch DSL → results with highlights,
   facets, family info.
4. **Export/Production**: selection snapshot frozen → Bates reserved
   atomically → render/stamp/redact in sandboxed workers → verify hashes →
   manifests → expiring authorized download.

### Key decisions (full ADRs in `docs/adr/`)

- ADR-001 pnpm+Turborepo monorepo; ADR-002 NestJS+Fastify for api/worker;
  ADR-003 Prisma on PostgreSQL 16 with RLS enforced via
  `SET LOCAL app.tenant_id` per transaction; ADR-004 BullMQ over Redis with a
  transactional outbox (Postgres) as the source of job truth; ADR-005
  content-addressed originals under `tenants/{t}/originals/sha256/{p2}/{hash}`;
  ADR-006 OpenSearch behind `SearchAdapter`; ADR-007 query language parsed to
  a typed AST (never raw passthrough); ADR-008 envelope encryption with
  `KeyEncryptionProvider` (local AES-256-GCM KEK default, KMS adapters
  documented); ADR-009 Authentik as sole IdP via standards-only OIDC (works
  with any conformant IdP); ADR-010 hash-chained append-only audit log.

## 2. Milestones

### M1 — Foundation (this milestone)

Planning docs, ADRs, monorepo scaffold with pnpm/turbo/tsconfig/eslint/
prettier/vitest, `packages/config` (Zod env validation, fail-fast startup),
`.env.example`, GitHub Actions CI (install → lint → typecheck → test → build),
`.gitignore`, base README. **Exit:** `pnpm install && pnpm build && pnpm test`
green from clean checkout.

### M2 — Identity, tenancy, audit

`packages/database` initial schema (Tenant, User, Membership, RoleAssignment,
AuditEvent, OutboxEvent) + RLS policies + audit append-only trigger; api OIDC
relying party (openid-client), session cookies, role guards, `/api/v1/me`;
audit service with hash chain + `scripts/audit-verify.ts`. **Exit:** unit +
integration tests for OIDC validation, RLS cross-tenant denial, chain verify.

### M3 — Evidence core

Full Prisma canonical model; `packages/evidence` streaming hasher and
content-addressed S3 store (staging → verify → promote), manifest builder with
Merkle root; outbox dispatcher + BullMQ wiring with dedup keys and backoff.
**Exit:** store/retrieve/verify round-trip tests against MinIO (Testcontainers)
or s3 mock; outbox at-least-once with idempotent consumers proven by test.

### M4 — Delegated connectors

Connector SPI (`discover`, `enumerate`, `fetchItem`, `delta`), Microsoft Graph
delegated adapter (mail folders incl. nested + recoverable when permitted,
message list/pages, MIME `$value` fetch, folder delta; OneDrive children +
delta, downloads), Google adapter (Gmail list/raw/history, Drive
files/changes/export), OAuth connect flows, encrypted token vault,
Retry-After/backoff/throttle middleware, recorded contract fixtures + local
fake provider server for tests/demo. **Exit:** contract tests green including
pagination, throttling, token expiry, delta resume, duplicate delivery.

### M5 — Organization modes

Entra application-permission mode (admin consent URL flow, user enumeration,
scoping docs), Google service-account DWD (key intake → encrypt, domain
allowlist validation, impersonated collection), custodian enumeration and
selection APIs. **Exit:** org-mode contract tests; negative tests for
out-of-allowlist domains and unconsented tenants.

### M6 — Collection orchestration

Wizard (8 steps, resumable, accessible), collection state machine
(discovering → fetching → processing → finalizing → terminal states),
checkpoints, pause/resume/cancel/retry-failed, per-custodian progress,
exceptions ledger, signed manifest + human-readable completeness report with
the five defined completeness states. **Exit:** kill-worker-mid-collection test
resumes without duplicates or checkpoint loss; manifest hashes verify.

### M7 — Processing pipeline

MIME parser (mailparser + raw header preservation), family/attachment
extraction, Tika text extraction, Tesseract OCR with page confidence,
LibreOffice conversions, safe HTML email preview sanitizer (rehype +
allowlist, no remote fetch), PDF/image previews with resource limits, ClamAV
scan + quarantine class, archive-bomb guards, SHA-256 dedup with logical
records preserved. **Exit:** MIME edge-case suite (nested multiparts, encoded
words, message/rfc822 attachments, BCC present/absent, S/MIME), bomb tests,
quarantine tests.

### M8 — Search

Versioned mapping (email+file+OCR fields, raw headers as key/value), bulk
indexer with retry + DLQ + reindex-from-truth command, query parser
(phrases, boolean, parens, wildcard limits, fuzzy, proximity, fielded syntax,
ranges) → AST → authz filter injection → DSL compile, facets, highlight,
search_after, saved searches, "why matched" panel data. **Exit:** field-by-field
search tests, injection/cost-limit adversarial tests, tenant bypass tests.

### M9 — Review workspace & cases

Three-pane workspace (virtualized results, safe preview tabs incl. raw
headers/family/chain), tags (color, privileged/confidential/hidden, family
behavior, bulk ops), cases (reference-only membership, roles, notes), saved
searches. **Exit:** Playwright flows + audit assertions for every mutation.

### M10 — Exports

Native export (streamed ZIP64, family layout, manifest.json/csv, hash list,
README, split archives), CSV export (column selection, RFC 4180,
formula-injection guard), async + resumable, verify-before-ready, expiring
audited downloads. **Exit:** export of seeded corpus verifies bit-for-bit
against collection manifest; CSV injection tests.

### M11 — Productions

10-step wizard, selection freeze, previously-produced exclusion, sort with
family adjacency, six-position stamps, preview/final redactions with burn-in

- leakage validation (text extraction + visual regression), Bates reservation
  (atomic ranges), natives policy with safety overrides, DAT/OPT/TEXT/IMAGES/
  NATIVES/MANIFESTS layout, placeholders, immutable runs + clone-to-draft.
  **Exit:** acceptance scenarios 4 & 5; concurrency test on Bates; load-file
  escaping tests.

### M12 — Governance & operations

Retention policies, legal holds blocking deletion, two-phase audited deletion
with manifest, quotas, OpenTelemetry + Prometheus + probes + graceful
shutdown, alert conditions documented. **Exit:** hold-blocks-deletion tests;
metrics endpoints scraped in compose.

### M13 — Hardening & delivery

Full E2E acceptance scenarios 1–7, axe accessibility scans + keyboard flows,
security tests (CSRF, headers, SSRF allowlist, redaction of secrets in logs),
compose + k8s manifests, Authentik blueprint, provider setup guides, runbooks,
SBOM (CycloneDX) + license report, `VERIFICATION.md` with exact results and
residual risks, final handoff.

## 3. Cross-cutting rules enforced from M1

- Every tenant-owned table: `tenant_id` + RLS; repositories require tenant
  context; no `prisma.$queryRaw` without tenant guard review.
- Every state mutation that matters: audit event in the same transaction.
- Every job: stable dedup key, bounded retries with exponential backoff +
  jitter, idempotent handler, heartbeat/lease.
- Every byte stream: no full buffering; hash while streaming.
- Every external HTTP call from workers: egress allowlist + timeout + circuit
  breaker; honor `Retry-After`.
- Every user-visible completeness/scope statement uses the qualified
  vocabulary from the contract (§20 truthfulness requirements).
- Dependencies pinned via lockfile + exact versions for security-sensitive
  packages; SBOM generated in CI.
- TDD: each module lands with its tests in the same change; CI gates merge.

## 4. Verification strategy

Unit (Vitest) per package; integration (Testcontainers: Postgres, Redis,
OpenSearch, MinIO) for RLS, outbox, store, indexer; contract tests for
connectors against recorded fixtures + fake server; Playwright E2E against the
compose stack in demo seed mode; axe-core accessibility scans; adversarial
security tests (tenant bypass, query cost, CSV/DAT injection, redaction
leakage). Final results, environment caveats (e.g., availability of a
container runtime on the build host), and residual risks land in
`VERIFICATION.md`.
