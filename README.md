# EvidenceVault

Self-hostable, multi-tenant eDiscovery platform: collect, preserve, index,
review, tag, export, and produce email and cloud-drive evidence from
Microsoft 365 / Outlook / OneDrive and Google Workspace / Gmail / Drive.

- **Login**: Authentik via standards-compliant OpenID Connect (code + PKCE)
- **Evidence storage**: Wasabi or any S3-compatible store (MinIO locally),
  content-addressed and immutable
- **Truth**: PostgreSQL 16 (with row-level security) · **Search**: OpenSearch 2.x
  (replaceable adapter) · **Jobs**: Redis 7 + BullMQ over a transactional outbox
- **Processing**: Apache Tika, Tesseract OCR, LibreOffice headless, ClamAV —
  in locked-down worker containers

> **Status: under active initial development.** This README is expanded per
> milestone; see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the
> milestone map and `VERIFICATION.md` (final milestone) for verified results.

## Repository layout

```
apps/web        Next.js review UI          apps/api      NestJS REST API (OIDC)
apps/worker     BullMQ ingestion/production workers
packages/       config · contracts · database · connectors · evidence ·
                search · production · ui
infra/          docker · compose · kubernetes · authentik
docs/adr        Architecture decision records (ADR-001 … ADR-010)
```

## Quick start (development)

```bash
corepack enable && corepack prepare pnpm@11.20.0 --activate
pnpm install
cp .env.example .env        # adjust if needed; safe local defaults
pnpm build && pnpm test     # unit tests
# Full local stack (Postgres, Redis, OpenSearch, MinIO, Authentik, ClamAV, Tika):
docker compose -f infra/compose/docker-compose.yml up -d
```

## Honest-limitations policy

EvidenceVault's UI and manifests never claim an unqualified "complete" —
collections report one of `complete_within_selected_api_scope`,
`complete_with_exceptions`, `partial`, `failed`, `cancelled`, with an
exceptions ledger. Delegated OAuth collects only what the consenting identity
can see. BCC is shown only when actually present in acquired data. Hashes and
chain-of-custody support defensibility but do not by themselves guarantee
admissibility or regulatory compliance — consult qualified counsel.
