# AEG-CloudDFIR

Self-hostable, multi-tenant eDiscovery platform: **collect, preserve, index,
review, tag, export, and produce** email and cloud-drive evidence from
Microsoft 365 / Outlook / OneDrive and Google Workspace / Gmail / Drive.

| Concern         | Choice                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Login           | Authentik via standards-compliant OIDC (code + PKCE); MFA enforced at the IdP                         |
| Evidence bytes  | Wasabi or any S3-compatible store (MinIO locally) — content-addressed, immutable originals            |
| Source of truth | PostgreSQL 16 with row-level security per tenant + hash-chained append-only audit log                 |
| Search          | OpenSearch 2.x behind a replaceable adapter; typed query AST with server-side tenant-filter injection |
| Jobs            | Redis 7 + BullMQ fed by a transactional outbox; idempotent, resumable, checkpointed                   |
| Processing      | Apache Tika, Tesseract OCR, LibreOffice, ClamAV — locked-down worker containers only                  |

## Quick start (local development)

Prerequisites: Node 22, pnpm 9+, Docker (Compose v2).

```bash
corepack enable && corepack prepare pnpm@11.20.0 --activate
pnpm install
pnpm build && pnpm test                      # 800+ unit tests

cp .env.example .env                         # safe local defaults; generate real secrets:
#   CDFIR_SESSION_SECRET:       openssl rand -hex 32
#   CDFIR_KEK_LOCAL_MASTER_KEY: openssl rand -base64 32

docker compose -f infra/compose/docker-compose.yml up -d   # postgres redis opensearch minio clamav tika authentik
pnpm --filter @aeg-clouddfir/database run migrate:deploy   # uses CDFIR_DATABASE_MIGRATION_URL

pnpm --filter @aeg-clouddfir/api dev        # :4000
pnpm --filter @aeg-clouddfir/worker dev
pnpm --filter @aeg-clouddfir/web dev        # :3000
```

Login: `http://localhost:3000` → redirects to Authentik
(`akadmin@localhost` / the `CDFIR_LOCAL_AUTHENTIK_ADMIN_PASSWORD` you set,
default `admin-local-only`).

### Demo seed mode (clearly labeled; refused in production)

Evaluate the full pipeline without real provider credentials:

```bash
# .env: CDFIR_DEMO_MODE=true and provider base URLs pointed at the fake server
pnpm tsx scripts/demo-provider.ts     # sanitized fixture provider on :4010 (keep running)
# log in once via the web app, then:
pnpm tsx scripts/demo-seed.ts         # demo tenants + seeded fake connectors
```

Then run the collection wizard against the seeded Microsoft/Google accounts.
Real provider OAuth flows are fully implemented and used whenever
`CDFIR_MS_CLIENT_ID` / `CDFIR_GOOGLE_CLIENT_ID` are configured — the demo server is
never in a production code path.

## Documentation

- Setup guides: [Wasabi](docs/guides/wasabi-setup.md) ·
  [Authentik](docs/guides/authentik-setup.md) ·
  [Microsoft Entra](docs/guides/microsoft-setup.md) ·
  [Google / Workspace DWD](docs/guides/google-setup.md) ·
  [Audit log collection](docs/guides/audit-logs.md) ·
  [Key management](docs/guides/key-management.md)
- Operations: [runbooks](docs/runbooks/) (backup/restore, DR, key rotation,
  connector revocation, reindexing, audit verification, upgrades, incident
  response incl. the disabled-by-default break-glass design)
- Design: [architecture + diagrams](docs/architecture.md), [ADRs](docs/adr/),
  [threat model](THREAT_MODEL.md), [plan](IMPLEMENTATION_PLAN.md),
  [assumptions](ASSUMPTIONS.md)
- Deployment: [Docker Compose](infra/compose/docker-compose.yml) ·
  [Kubernetes](infra/kubernetes/)
- Verification: `VERIFICATION.md` (exact commands, results, residual risks)

Ops commands: `pnpm audit:verify` (audit hash chains), `pnpm tsx
scripts/reindex.ts` (rebuild search from truth), `pnpm sbom` (CycloneDX SBOM +
license report).

## Honest limitations (read before relying on this)

- **Completeness is always qualified.** Collections report one of
  `complete_within_selected_api_scope`, `complete_with_exceptions`, `partial`,
  `failed`, `cancelled` — never an unqualified "complete". "All time" means
  items returned within the selected account, its permissions, the
  API-visible scope, retention state, and provider limitations.
- **Delegated OAuth** collects only what the consenting identity can access;
  it does not make other users' accounts selectable.
- **BCC** is indexed/shown only when actually present in acquired data.
- **Google-native files** are preserved as API exports (flagged as
  derivatives), not byte-identical natives; exports over ~10 MB per format
  become recorded exceptions.
- **Encrypted/rights-managed/corrupt/unavailable content** produces
  exceptions; nothing is brute-forced.
- **Audit logs** are bounded by provider retention (Microsoft Purview and
  Google Workspace Reports both retain ~180 days). Events outside the retained
  window, or never captured because auditing was disabled when they occurred,
  cannot be collected and are reported as scope limitations — not silently
  omitted. Audit collection is organization-scoped only.
- **Google Vault** integration is metadata-only for now: it enumerates
  matters/exports but does not yet download the export archive from the GCS
  export sink.
- **WORM immutability** is claimed only when bucket versioning + Object Lock
  are actually detected; otherwise the UI says exactly what protects the data.
- **OCR/rasterization** require the worker container's tools (Tesseract,
  pdftoppm); on hosts without them the pipeline records honest exceptions and
  productions downgrade image formats rather than fake output.
- Hashes, manifests, and the audit chain **support defensibility but do not
  by themselves guarantee admissibility or regulatory compliance** — consult
  qualified counsel for your jurisdiction and matter.

## License

Apache-2.0. Not legal advice; no compliance claims.
