# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to work with this user (read first)

**Write at a 5th-grade reading level, always.** Short sentences. Common words.
No jargon unless it is defined in the same sentence. Use a plain analogy for
anything abstract. This is not about dumbing things down — the facts, commands,
file paths and honest limits stay exact. It is about not burying the answer.
Lead with the answer in one plain sentence, then the detail.

**Instruct; do not take over.** The default is to hand the user the exact command
to run, labelled **[MAC]**, **[SERVER]** or **[BROWSER]**. Only offer "want me to
run it?" when the command is BOTH simple AND cannot break the app. Everything
else is theirs to run, with clear steps from you.

Safe to offer, or to just run when investigating:

- reading things: `git log`, `grep`, `df -h`, `docker ps`, `curl` a health
  endpoint, `gh run list`, `psql` SELECTs
- running tests, lint, typecheck, builds on the **Mac**

Do NOT offer; write the steps and let the user run them:

- anything that restarts, recreates, or stops a container
- deploys, and anything that changes what production is serving
- editing `.env`, secrets, keys, or `authorized_keys` on the server
- deleting anything: images, volumes, files, database rows
- `sudo`, cron changes, firewall or system settings
- changing GitHub repository settings, secrets, or environments

The user creates and pastes their own secrets. Never ask for a private key and
never print one.

## Commands

```bash
pnpm install                  # Node 22, pnpm 11.20.0 (corepack prepare pnpm@11.20.0 --activate)
pnpm build                    # turbo; every other task dependsOn ^build
pnpm lint && pnpm typecheck && pnpm test
pnpm format                   # prettier --write .  (format:check is CI's FIRST step — see below)
pnpm test:integration         # needs a live postgres; CDFIR_IT_DATABASE_URL
```

Single package / single file / single test:

```bash
pnpm --filter @aeg-clouddfir/api run test
pnpm --filter @aeg-clouddfir/api exec vitest run src/productions/productions.test.ts
pnpm --filter @aeg-clouddfir/api exec vitest run src/productions/productions.test.ts -t "returns every run field"
```

Local stack and dev servers: see README.md. Migrations are
`pnpm --filter @aeg-clouddfir/database run migrate:deploy` and read
`CDFIR_DATABASE_MIGRATION_URL` (the migrator role), not `CDFIR_DATABASE_URL`.

`pnpm format:check` runs **before** lint and tests in CI, so unformatted code
fails the pipeline in ~30s and nothing else ever runs. Between 2026-08-13 and
2026-08-18 that hid a genuinely broken test on main. Run `pnpm format` before
committing.

## Architecture

Nine packages under `packages/`, three apps under `apps/` (api = NestJS on
Fastify, worker = BullMQ consumers, web = Next.js App Router). The parts that
span files and are easy to break:

- **Tenant isolation is in the database, not the service layer.** 49 tables carry
  `FORCE ROW LEVEL SECURITY`. All tenant queries go through
  `withTenantContext(prisma, tenantId, fn)`, which sets `app.tenant_id` for the
  transaction; `withPlatformContext` sets `app.platform` and deliberately has
  **no** policy on evidence tables. Consequence: `psql -U cdfir` with no tenant
  context returns **zero rows from everything**, and `pg_dump` as the owner
  silently produces a near-empty dump — always dump as superuser.
- **Jobs are dispatched through a transactional outbox.** Services write an
  `outbox_events` row inside the same transaction as their state change; the
  worker dispatches to BullMQ. Never enqueue directly from a service. Dedup keys
  make retries idempotent (retries append `:retry<ts>`).
- **Evidence storage is content-addressed and write-once**: stage → verify hash →
  promote. `packages/evidence/src/store.ts` is the only thing that talks to S3.
  Server-side copies above 5 GiB must use `copySized()` (multipart
  `UploadPartCopy`); a plain `CopyObject` fails at that limit. Download filenames
  must be signed into the URL via `ResponseContentDisposition` — the HTML
  `download` attribute is ignored cross-origin.
- **The audit log is a hash chain** (`appendAuditEvent` / `audit.appendTx`), append
  only, verified by `pnpm audit:verify`. Anything that discloses evidence
  (exports, production downloads) must append an event.
- **`packages/contracts` is the API↔web boundary.** Shared Zod schemas; the client
  validates responses with the same schema the API is tested against. When an
  endpoint's shape changes, change the contract and test the service against it —
  a mismatch type-checks fine and fails at runtime in the browser.
  In `apps/web/src/lib/schemas.ts` re-export with
  `export { name } from '@aeg-clouddfir/contracts'`, never
  `import` + `export { name }` — the latter passes tsc and unit tests but breaks
  `next build` with "has no internal name".
- **Search goes through an adapter** with a versioned index behind an alias
  (`MAPPING_VERSION` in `packages/search`). `ensureIndex()` must be called or
  OpenSearch auto-creates a dynamic mapping, and aggregations then fail on text
  fields. Reindex with `pnpm tsx scripts/reindex.ts`.
- **`apps/api` uses type-based DI**, so it needs `emitDecoratorMetadata`. Its
  `dev` script is `tsc --watch` + `node --watch`, **not** `tsx watch`: esbuild
  silently drops that option and Nest then fails to resolve providers — guarded
  routes return opaque 500s while `/healthz` still passes.

Design docs are in `docs/architecture.md` and `docs/adr/`; threat model in
`THREAT_MODEL.md`. Read the relevant ADR before changing one of the above.

## Two machines — always say which one

Commands are not interchangeable, and the user has asked to be told explicitly.
Label every command **[MAC]**, **[SERVER]**, or **[BROWSER]**.

- **[MAC]** `/Users/ic/Documents/CloudDiscovery`. The `cdfir-server` ssh alias and
  `pbcopy` exist only here.
- **[SERVER]** `ssh cdfir-server` → `/var/www/AEGCloudDFIR`. Production. **Shared
  with an unrelated application**: a host PostgreSQL owns 127.0.0.1:5432, so every
  CloudDFIR host port is remapped in `.env` (`CDFIR_*_HOST_PORT`, e.g. postgres
  55432, redis 56379, Grafana 53000). Never touch the host `postgresql` service.

## Deployment

CI (`ci.yml`) → images (`release.yml`, only on green CI) → deploy. Both deploys
are manual and run from the Actions tab: `deploy-staging.yml` (one click) and
`deploy.yml` (`production` environment, required reviewer, `main` only).
**Do not commit until the operator asks**; they run every deploy themselves.
`scripts/deploy.sh` runs on the host, verifies `/readyz` plus the public site, and
rolls back to the previously deployed tag on failure. Full setup and rollback:
`docs/runbooks/deploy.md`.

Traps that have each caused an outage or silent breakage here:

- **Never build images on the server.** It has no pnpm, and buildx cache reached
  48 GB on a 98 GB disk and broke a deploy mid-`git pull`. CI builds; the host
  pulls.
- **Always pass `--env-file ../../.env` to compose** (or run from the repo root).
  Interpolation reads the `.env` in the _current_ directory, not the services'
  `env_file`. Omitting it applies every default: colliding host ports and
  `changeme-local-only` as the database password. The server symlinks
  `infra/compose/.env` so either invocation works.
- **Do not quote values in `.env`.** Compose passes surrounding quotes _into_ the
  value. Write `KEY=value`. Anything with spaces needs care in both directions,
  because shell-sourcing and compose disagree.
- **`NEXT_PUBLIC_*` are baked into the web bundle at image build time.** A wrong
  value cannot be fixed by restarting; it needs a rebuild.
- The deployed tag is persisted as `CDFIR_IMAGE_TAG` in the server `.env`, so a
  later plain `up -d` cannot silently swap images.

## Monitoring and backups

`packages/monitoring` runs on the host every 5 minutes from cron and reports to a
healthchecks.io dead-man's switch: failures ping `/fail`, and **silence is itself
an alert**. Prometheus + Grafana + node-exporter are in the `monitoring` compose
profile, bound to localhost. Details, thresholds and the SSH tunnel:
`docs/runbooks/monitoring.md`.

Backups run 03:15 UTC (`scripts/backup-postgres.sh`), dump as superuser, verify by
re-reading, and write `.last-backup` only after that verification — the monitor
treats a stale stamp as a failed backup. Restore procedure:
`docs/runbooks/backup-restore.md`.

## Working style in this repo

- **Never report pipeline or deployment state from inference — check it.**
  `gh run list --workflow=CI -L 5 --json headSha,status,conclusion`, the same for
  `"Release images"`, and `grep CDFIR_IMAGE_TAG` in the server's `.env` /
  `.env.staging` for what is actually running. Do not describe a queue, an ETA, or
  what an environment "should" have; those claims have been wrong in both
  directions — inventing a backlog that did not exist, and saying a change was
  still waiting when its image had already shipped. One image contains every
  commit up to its SHA, so a later green build supersedes earlier ones.

- **Verify inside the running container or against the real artifact**, not by
  build exit codes. Every fault found here had the signature "reports success,
  silently broken": a healthy container with credentials that had never worked, a
  web image that failed to build for several deploys, `docker ps` healthy while
  the queue connection was refused, backups that stopped for a day.
- **Prefer a real-input test over more mocks** when behaviour depends on an
  external tool. Fully mocked tests passed for a LibreOffice conversion that
  produced no output at all.
- Explain in plain language by default; the user has asked for this repeatedly.
- OpenSearch **requires authentication** (compose defaults
  `plugins.security.disabled` to `false`); the app user is `cdfir_app`, limited to
  `cdfir-*`. REST TLS is deliberately off — see
  `docs/runbooks/opensearch-security.md`. `/readyz` probes search as well as the
  database and object storage, so a search outage fails readiness — and blocks a
  deploy, deliberately.
- Known gaps, deliberately open: Microsoft/Google connector credentials are empty
  so those flows are untested; `README.md` "Honest limitations" lists the rest.

## Keeping this file current

Add to it when something here is learned the hard way — a trap, an invariant, a
command that is not discoverable. Keep entries short and say _why_, because the
reason is what makes them stick. Do not duplicate `docs/`; link to it.
