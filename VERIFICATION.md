# VERIFICATION

This document records the exact commands run to verify EvidenceVault, their
results, the environment they ran in, residual risks, and the features that
could not be fully completed. It reflects the state at commit `c5a283a`.

## Environment

| Component         | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Build host        | macOS (darwin arm64), Homebrew                                               |
| Node.js           | v22.23.2                                                                     |
| pnpm              | 11.20.0                                                                      |
| Container runtime | Colima + Docker 29.5.2 (installed during verification)                       |
| Database          | PostgreSQL 16 (compose), migrations applied under a NOBYPASSRLS runtime role |
| Search            | OpenSearch 2.19.1 (compose)                                                  |
| Object store      | MinIO (compose), S3-compatible; Wasabi in production                         |
| IdP               | Authentik 2025.4 (compose), OIDC code+PKCE                                   |

The full local stack (Postgres, Redis, OpenSearch, MinIO, ClamAV, Tika,
Authentik ×2, Authentik Postgres/Redis — 10 containers) was started with
`docker compose -f infra/compose/docker-compose.yml up -d` and all reported
`healthy`.

## Static gates (whole workspace)

| Command                                  | Result                           |
| ---------------------------------------- | -------------------------------- |
| `pnpm install`                           | clean install from lockfile      |
| `pnpm format:check`                      | PASS                             |
| `pnpm lint`                              | PASS (19/19 tasks)               |
| `pnpm typecheck`                         | PASS (19/19 tasks)               |
| `pnpm build`                             | PASS (all packages + Next build) |
| `pnpm exec tsc -p scripts/tsconfig.json` | PASS (ops scripts typecheck)     |
| `docker compose ... config -q`           | PASS (compose file valid)        |

## Unit tests — `pnpm test`

**785 unit tests passing** across all 11 workspace packages:

| Package                     | Tests | Notable coverage                                                                                                                                                                                                              |
| --------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@evidencevault/config`     |     6 | env validation, fail-fast, secret redaction, demo-in-prod refusal                                                                                                                                                             |
| `@evidencevault/database`   |    14 | canonical JSON, audit hash chain determinism/tamper, envelope encryption (AAD tenant binding, rotation)                                                                                                                       |
| `@evidencevault/contracts`  |     8 | completeness vocabulary rejects "complete"/"all data"; production/export DTOs; truthfulness notices present                                                                                                                   |
| `@evidencevault/evidence`   |   162 | streaming SHA-256, content-addressed store (stage→verify→promote, dedup, presign refusal, Object Lock honesty), Merkle manifests, MIME parse edge cases, safe-preview sanitizer, OCR/Tika/ClamAV clients, archive-bomb guards |
| `@evidencevault/connectors` |    69 | Graph mail/drive + Gmail/Drive (delegated + org), Retry-After/backoff, delta/history resume + expiry, DWD domain allowlist, no-auth content redirect                                                                          |
| `@evidencevault/search`     |   173 | query AST parse/validate/compile, **unconditional tenant-filter injection (adversarial matrix)**, cost limits, facets, reindex alias swap                                                                                     |
| `@evidencevault/production` |   103 | Bates overflow, family-adjacent sort, 18-flag validation incl. non-overridable redaction leak, stamping, redaction burn-in + no-text-layer gate, TIFF G4, OPT/DAT/CSV escaping                                                |
| `@evidencevault/ui`         |    16 | dialog focus trap, roving tabindex (DOM-free logic)                                                                                                                                                                           |
| `@evidencevault/web`        |    39 | wizard reducer gating + resume + stable idempotency key, mark-token-only highlight parsing, CSRF header logic                                                                                                                 |
| `@evidencevault/api`        |   127 | OIDC helpers, sealed sessions, CSRF, guards, audit pagination + chain verify, connectors, collections lifecycle, search authz, evidence authz, tags/families, cases, exports, production validation/submit                    |
| `@evidencevault/worker`     |    68 | outbox dispatch (SKIP LOCKED, dedup, failure accounting), DST-safe date scoping, checkpoint version guard, fetch-item idempotency, finalize completeness matrix, scan/quarantine, production run                              |

## Migrations — applied to an empty database

`prisma migrate deploy` under the `evidencevault_migrator` role applied both
migrations (`20260807000001_init`, `20260807000002_rls_and_audit_guards`) to a
freshly created database. Verified fail-closed RLS immediately after:

```
psql -U evidencevault -c "SELECT count(*) FROM tenants"  → 0
```

(The runtime role sees zero rows without a tenant context set.)

## Integration tests (live PostgreSQL, NOBYPASSRLS runtime role)

`EV_IT_DATABASE_URL=... pnpm --filter @evidencevault/database test:integration`
— **8 passed**:

- session without tenant context sees zero tenant rows (fail closed)
- tenant context exposes only that tenant; cross-tenant `findUnique` by PK → null
- `WITH CHECK` blocks inserting rows for a foreign tenant
- cross-tenant UPDATE/DELETE affect zero rows
- audit chain appends per tenant and verifies; `UPDATE`/`DELETE` on
  `audit_events` both raise (append-only trigger)
- per-tenant audit chains are independent
- outbox rows invisible without worker context, visible with it
- evidence blob content identity is immutable (trigger)

## Audit chain verification — `pnpm audit:verify`

All tenant chains intact:

```
✔ Demo Matter Workspace: 125 events, chain intact
✔ Adverse Party Workspace: 0 events, chain intact
✔ IT Tenant A: 3 events, chain intact
✔ IT Tenant B: 1 events, chain intact
```

## End-to-end (Playwright, live stack, demo seed) — 24 tests + scenario 3

Setup logs in through the real Authentik code+PKCE flow once and reuses the
session. Demo data seeded via `scripts/demo-seed.ts`; the fake provider server
(`scripts/demo-provider.ts`) serves sanitized fixtures.

**Acceptance scenarios demonstrated live:**

1. **Collect → preserve → index → completeness (scenario 1)** — a bounded
   Microsoft email collection runs through the real api + worker + fake
   provider to `status=completed`, `completeness=complete_within_selected_api_scope`,
   with preserved originals (SHA-256, deduped), an email→attachment **family**,
   safe-HTML and text **previews**, extracted **attachment text**, and a
   **signed manifest**. The UI wizard renders and is reachable.
2. **Forensic search (scenario 2)** — verified against the live index:
   `from:`, `to:`, `cc:`, real-header `bcc:`, `subject:`, arbitrary
   `header.mime-version:`, body phrase, **attachment full-text**, `hash:`,
   and Boolean `AND`/`NOT`. Adversarial: `tenantId:` is rejected (not a
   queryable field); leading wildcard and unknown fields → 400.
3. **Tag family → case → export (scenario 3)** — tag an email with
   `apply_to_family`, create a case, add the tagged family by reference
   (≥2 items: email + attachment), then run **native and CSV exports**; both
   reach `ready` (the worker verifies every output hash before marking ready).
4. **Cross-tenant isolation (scenario 6)** — evidence/collection/export/
   production/case routes for a foreign id all return **404 without existence
   leakage**; search never returns another tenant's items.
5. **Kill-and-resume (scenario 7)** — during verification the worker process
   died mid-collection with a pending `collection.discover` outbox row;
   restarting it **resumed and completed** the collection with no duplicate
   logical items and no lost checkpoint (the outbox re-dispatched; BullMQ
   dedup jobIds collapsed replays).

Accessibility: structural + keyboard specs assert landmarks, a single `h1`,
skip link, visible focus, and `aria-current="step"` on the wizard across the
primary pages.

**Scenarios 4 and 5 (production: final-redacted TIFF/PDF with Bates + load
files; redacted-native leakage blocked)** are verified at the unit and
integration level, not via a live E2E run:

- `@evidencevault/production` (103 tests) covers Bates continuity across
  families, stamping, **redaction burn-in validated by pixel readback and a
  no-text-layer gate**, TIFF G4, and DAT/OPT/CSV escaping.
- `@evidencevault/api` production tests assert the validation flag matrix,
  that a **security-critical redaction/native leak is not overridable without
  a second confirmation (403)**, stale-draft 409, and atomic Bates reservation.
- `@evidencevault/worker` `production-run` test asserts a redacted item
  requesting native output becomes a **placeholder with a security exception**
  rather than shipping the native, and that a `validateNoTextLayer` failure
  forces a placeholder.
  A live production render was not exercised end-to-end because PDF
  rasterization (pdftoppm/TIFF) is not installed on the host API/worker used
  for verification; the worker records honest exceptions and downgrades image
  formats in that case (see Residual risks).

## Security spot-checks (live API)

- Secure headers present on every response: `Content-Security-Policy:
default-src 'none'; …`, `X-Frame-Options: DENY`, `X-Content-Type-Options:
nosniff`, `Strict-Transport-Security`, echoed `x-request-id`.
- CSRF: a mutating POST without `x-csrf-token` → **403**.
- No presigned URLs and no tokens/secrets/private keys found in api or worker
  logs (`grep -ci` → 0).
- Search cost limits: leading wildcard and unknown field → **400**; `tenantId`
  is not registered as a queryable field.

## SBOM

`pnpm run sbom:generate` → `sbom/sbom.cdx.json` (CycloneDX, **581
components**) + `sbom/licenses.csv`. No strong-copyleft/unlicensed components
flagged.

## Residual risks and known limitations

1. **PDF/image rasterization not exercised live.** The worker container ships
   Tesseract, LibreOffice, poppler, and Ghostscript, but the host used for
   verification had none, so OCR and production image rendering ran their
   honest-exception paths. In-container verification of TIFF/PDF production
   output remains a follow-up. Redaction leakage is still blocked in this
   state (items become placeholders).
2. **Live provider verification pending.** All connector logic is verified
   against recorded fixtures and the fake server. The one manual step
   requiring administrator credentials: register the Entra app / Google OAuth
   client (and, for org mode, admin consent / domain-wide delegation), set
   `EV_MS_*` / `EV_GOOGLE_*`, and run one real collection. See the setup
   guides in `docs/guides/`.
3. **ClamAV signature warm-up.** `clamav/clamav-debian:1.4` downloads
   signatures on first start (several minutes); scans return `scan_failed`
   (recorded, non-fatal) until ready.
4. **KEK rotation rewrap tool is documented, not yet scripted** (the
   `KeyEncryptionProvider` interface and rotation runbook exist;
   `scripts/kek-rotate` is a roadmap item).
5. **Continuous (delta) collection** persists delta/history checkpoints and is
   unit-tested, but a full incremental second-pass over a live provider was
   not exercised here.
6. **Object Lock / WORM** is detected and reported honestly; enabling it is an
   operator action on the bucket (see `docs/guides/wasabi-setup.md`). The
   verification stack (MinIO) had versioning enabled, Object Lock disabled —
   the app correctly reported "no WORM guarantee".
7. **Demo corpus is small** (sanitized fixtures). Scale/throughput and the
   dead-letter path under sustained load were not load-tested.

## Reproducing

```bash
docker compose -f infra/compose/docker-compose.yml up -d
pnpm install && pnpm build
pnpm --filter @evidencevault/database exec prisma migrate deploy   # migrator URL
pnpm test                                                          # 785 unit
EV_IT_DATABASE_URL=... pnpm --filter @evidencevault/database test:integration
# demo + E2E:
pnpm tsx scripts/demo-provider.ts &                                # :4010
node --env-file=.env apps/api/dist/main.js &                       # :4000
node --env-file=.env apps/worker/dist/main.js &
pnpm --filter @evidencevault/web start &                           # :3000
# log in once via the web app, then:
node --env-file=.env node_modules/.bin/tsx scripts/demo-seed.ts
pnpm exec playwright test
```
