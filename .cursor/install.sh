#!/usr/bin/env bash
# Cloud Agent install phase: prepare the repository so the unit gate
# (build / lint / typecheck / test) works, and install the tooling needed to
# run the full local stack in the start phase.
#
# Runs after the source is checked out. Must be idempotent and must terminate:
# no servers, no migrations, nothing that needs a live database.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Node package manager, pinned by package.json "packageManager".
corepack enable
corepack prepare pnpm@11.20.0 --activate

# 2. Workspace dependencies from the committed lockfile.
pnpm install --frozen-lockfile

# 3. Build every package. This also runs `prisma generate` (in the database
#    package build) so the Prisma client exists, and produces the dist/ output
#    the api and worker terminals run from.
pnpm build

# 4. System tooling to run the datastores in the start phase. The full local
#    stack (Postgres, Redis, OpenSearch, MinIO, Tika, Authentik) runs under
#    Docker Compose; fuse-overlayfs is the storage driver that works inside the
#    nested Cloud Agent VM. Guarded so the dev gate still works if apt is
#    unavailable (e.g. offline base image).
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq || true
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker.io docker-compose-v2 fuse-overlayfs || \
    echo "install.sh: docker install failed; the unit gate still works, but start.sh cannot bring up the stack"
fi

echo "install.sh: done"
