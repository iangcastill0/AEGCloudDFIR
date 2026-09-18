#!/usr/bin/env bash
# Cloud Agent start phase: bring up the local stack the api/worker/web terminals
# need. Runs on every boot. Idempotent: tolerates an already-running daemon,
# already-created state, and re-runs. Returns once the core datastores are ready
# (Authentik, needed only for browser login, is best-effort and never blocks).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
COMPOSE="infra/compose/docker-compose.yml"
OVERRIDE=".cursor/compose.cloud-agent.yml"
MC_IMAGE="quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z"

log() { echo "start.sh: $*"; }

# 0. SSH credentials for reaching self-hosted machines from the agent terminal.
#    Materialized from the AGENT_SSH_KEY secret (injected as an env var) so
#    `ssh cdfir-linode` works like on the operator's Mac. Runs before the Docker
#    section on purpose — it is independent of the local stack and must still
#    happen on a base image without Docker. No-op when the secret is absent;
#    best-effort so it never blocks environment start. Host/user are
#    overridable via AGENT_SSH_HOST / AGENT_SSH_USER (default: the Linode root).
if [ -n "${AGENT_SSH_KEY:-}" ]; then
  log "materializing agent SSH key from AGENT_SSH_KEY"
  install -d -m 700 "$HOME/.ssh"
  ( umask 077; printf '%s\n' "$AGENT_SSH_KEY" > "$HOME/.ssh/cdfir_agent" )
  chmod 600 "$HOME/.ssh/cdfir_agent"
  ssh_config="$HOME/.ssh/config"
  touch "$ssh_config"
  chmod 600 "$ssh_config"
  # Rewrite our managed block idempotently so host/user changes take effect and
  # re-runs never duplicate it.
  sed -i '/# >>> cdfir-agent managed >>>/,/# <<< cdfir-agent managed <<</d' "$ssh_config" 2>/dev/null || true
  {
    echo '# >>> cdfir-agent managed >>>'
    echo 'Host cdfir-linode'
    echo "  HostName ${AGENT_SSH_HOST:-74.207.235.208}"
    echo "  User ${AGENT_SSH_USER:-root}"
    echo '  IdentityFile ~/.ssh/cdfir_agent'
    echo '  IdentitiesOnly yes'
    echo '  StrictHostKeyChecking accept-new'
    echo '# <<< cdfir-agent managed <<<'
  } >> "$ssh_config"
else
  log "AGENT_SSH_KEY not set; skipping SSH key setup"
fi

if ! command -v docker >/dev/null 2>&1; then
  log "docker not installed; skipping stack bring-up (unit gate still works)"
  exit 0
fi

# 1. Docker in a nested VM: the nftables iptables backend cannot program the
#    bridge network, so containers cannot reach each other (Authentik and the
#    bucket init need this). The legacy backend works. fuse-overlayfs is the
#    only storage driver that mounts inside the VM.
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
sudo mkdir -p /etc/docker
echo '{"features":{"containerd-snapshotter":false},"storage-driver":"fuse-overlayfs"}' \
  | sudo tee /etc/docker/daemon.json >/dev/null

# 2. Start dockerd if it is not already responding.
if ! sudo docker info >/dev/null 2>&1; then
  log "starting dockerd"
  sudo bash -c 'nohup dockerd >/tmp/dockerd.log 2>&1 &'
  for _ in $(seq 1 30); do
    sudo docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! sudo docker info >/dev/null 2>&1; then
  log "dockerd did not come up; see /tmp/dockerd.log"
  exit 0
fi

# 3. Local .env with throwaway-local settings, if one is not already present.
if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
  sed -i 's/^#\s*CDFIR_OPENSEARCH_SECURITY_DISABLED=true/CDFIR_OPENSEARCH_SECURITY_DISABLED=true/' .env
  grep -q '^CDFIR_OPENSEARCH_SECURITY_DISABLED=true' .env || echo 'CDFIR_OPENSEARCH_SECURITY_DISABLED=true' >> .env
  sed -i 's/^CDFIR_CLAMAV_ENABLED=true/CDFIR_CLAMAV_ENABLED=false/' .env
  sed -i "s|^CDFIR_SESSION_SECRET=.*|CDFIR_SESSION_SECRET=$(openssl rand -hex 32)|" .env
  # Demo seed mode so the app is usable without real provider credentials, with
  # provider calls pointed at the bundled fake server (scripts/demo-provider.ts).
  sed -i 's/^CDFIR_DEMO_MODE=false/CDFIR_DEMO_MODE=true/' .env
  sed -i 's|^CDFIR_MS_GRAPH_BASE_URL=.*|CDFIR_MS_GRAPH_BASE_URL=http://127.0.0.1:4010/graph|' .env
  sed -i 's|^CDFIR_MS_LOGIN_BASE_URL=.*|CDFIR_MS_LOGIN_BASE_URL=http://127.0.0.1:4010|' .env
  sed -i 's|^CDFIR_GOOGLE_API_BASE_URL=.*|CDFIR_GOOGLE_API_BASE_URL=http://127.0.0.1:4010/google|' .env
  sed -i 's|^CDFIR_GOOGLE_OAUTH_TOKEN_URL=.*|CDFIR_GOOGLE_OAUTH_TOKEN_URL=http://127.0.0.1:4010/token|' .env
fi

dc() { sudo docker compose -f "$COMPOSE" -f "$OVERRIDE" --env-file .env "$@"; }

# 4. Datastores (the app's data plane) plus Authentik (login).
log "bringing up datastores"
dc up -d postgres redis opensearch minio tika || log "warning: datastore up returned non-zero"
dc up -d authentik-postgres authentik-redis authentik-server authentik-worker \
  || log "warning: authentik up returned non-zero"

# 5. Wait for Postgres, then apply migrations (idempotent).
log "waiting for postgres"
for _ in $(seq 1 60); do
  [ "$(sudo docker inspect -f '{{.State.Health.Status}}' cdfir-postgres-1 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
log "applying database migrations"
CDFIR_DATABASE_MIGRATION_URL="postgresql://cdfir_migrator:changeme-local-only@localhost:5432/cdfir" \
  pnpm --filter @aeg-clouddfir/database run migrate:deploy || log "warning: migrate:deploy failed"

# 6. Object-storage buckets. Done from the host network (reliable) rather than
#    the compose minio-init container.
log "ensuring MinIO buckets"
for _ in $(seq 1 20); do
  curl -fsS http://localhost:9000/minio/health/ready >/dev/null 2>&1 && break
  sleep 2
done
sudo docker run --rm --network host --entrypoint sh "$MC_IMAGE" -c '
  mc alias set l http://127.0.0.1:9000 minioadmin minioadmin-local-only &&
  mc mb --ignore-existing l/cdfir-evidence &&
  mc mb --ignore-existing l/cdfir-quarantine &&
  mc version enable l/cdfir-evidence' >/dev/null 2>&1 || log "warning: bucket setup failed"

# 7. Authentik OIDC discovery (best-effort; blueprint apply takes ~1-2 min on a
#    cold database). Login needs it, but the datastores and the api/worker are
#    ready regardless, so never block the environment on it.
log "waiting (best-effort) for Authentik OIDC discovery"
for _ in $(seq 1 24); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:9443/application/o/cdfir/.well-known/openid-configuration 2>/dev/null)"
  [ "$code" = "200" ] && { log "Authentik OIDC ready"; break; }
  sleep 5
done

log "done — datastores ready; api/worker/web start as terminals"
exit 0
