#!/usr/bin/env bash
#
# Run the health checker ON THIS HOST. Called by cron every 5 minutes:
#
#   */5 * * * * root /var/www/AEGCloudDFIR/scripts/monitor.sh
#
# Install that schedule from infra/cron/cdfir-monitor. Full setup, including the
# healthchecks.io side, is in docs/runbooks/monitoring.md.
#
# Why a wrapper and not `node .../cli.js` straight from cron:
#
# 1. ONE RUN AT A TIME. `docker ps` has no timeout of its own, so a wedged docker
#    daemon can park a run forever. Without the lock, cron would stack another
#    process on top every five minutes until the host ran out of room.
# 2. A DEADLINE, so the lock cannot be held by something that is never coming
#    back.
# 3. ONLY THE SETTINGS IT NEEDS. `node --env-file=.env` would load every
#    production secret into a process that posts to a third party. The checker
#    needs five values, so it gets five values. Nothing here sources .env.
# 4. A LOG THAT CANNOT GROW FOREVER, and quiet success. Cron mails whatever a job
#    prints, so a healthy run prints nothing and only the log records it.
#
# Every way this script can fail ends with NO PING being sent, which is the right
# outcome: healthchecks.io alerts on the silence. Nothing here may swallow an
# error and exit 0.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CDFIR_MONITOR_ENV_FILE:-$REPO_ROOT/.env}"
CLI="$REPO_ROOT/packages/monitoring/dist/cli.js"
LOG="${CDFIR_MONITOR_LOG:-/var/log/cdfir-monitor.log}"
LOCK="${CDFIR_MONITOR_LOCK:-/var/lock/cdfir-monitor.lock}"
# Well inside the five minute schedule, and well above the ~50s the probes' own
# timeouts add up to, so hitting it means something is genuinely stuck.
DEADLINE_SECONDS="${CDFIR_MONITOR_DEADLINE_SECONDS:-120}"
LOG_MAX_LINES="${CDFIR_MONITOR_LOG_MAX_LINES:-500}"

# This host is not set up to run the checker. Says which piece is missing.
EXIT_NOT_INSTALLED=70
# A previous run is still going. Deliberately distinct: it is not a broken host.
EXIT_ALREADY_RUNNING=75

# To the log always, and to stderr so cron mails it. For this script's own
# problems only; the checker's output is handled at the bottom.
note() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) monitor.sh: $1"
  printf '%s\n' "$line" >> "$LOG" 2>/dev/null || true
  printf '%s\n' "$line" >&2
}

# Read one key without executing the file.
#
# Sourcing .env runs it as a shell script, so one line the shell dislikes takes
# the whole thing down. That has happened here: an unquoted SSH host key parsed
# as a command name and the nightly backup stopped, silently. Same helper as
# scripts/deploy.sh and scripts/backup-postgres.sh.
env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  value="${line#*=}"
  # Tolerate values written with surrounding quotes, as a shell would.
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

LOCK_DIR="$(dirname -- "$LOCK")"
if [ ! -d "$LOCK_DIR" ] || [ ! -w "$LOCK_DIR" ]; then
  note "cannot write the lock file $LOCK — this is meant to run as root from cron"
  exit "$EXIT_NOT_INSTALLED"
fi

# One run at a time. An open file descriptor is the lock, so it is released when
# this process ends however it ends, including a kill.
exec 9>"$LOCK"
if ! flock -n 9; then
  note "a previous run is still going after five minutes — skipping this one"
  exit "$EXIT_ALREADY_RUNNING"
fi

NODE="${CDFIR_MONITOR_NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  note "node is not installed on this host, so the checker cannot run at all — see docs/runbooks/monitoring.md"
  exit "$EXIT_NOT_INSTALLED"
fi

if [ ! -f "$CLI" ]; then
  note "$CLI is missing. A production deploy installs it — see docs/runbooks/monitoring.md"
  exit "$EXIT_NOT_INSTALLED"
fi

if [ ! -f "$ENV_FILE" ]; then
  note "$ENV_FILE not found, so the ping URL cannot be read"
  exit "$EXIT_NOT_INSTALLED"
fi

# The ping URL is passed even when blank. Blank is meaningful — the checker then
# exits 2 to say nobody was notified — and it keeps this list non-empty.
env_args=("CDFIR_HEALTHCHECK_PING_URL=$(env_value CDFIR_HEALTHCHECK_PING_URL)")
# The rest are skipped when absent or blank, so the checker falls back to its own
# default instead of being handed an empty string it would treat as a real value.
for key in \
  CDFIR_WEB_PUBLIC_URL \
  CDFIR_API_HOST_PORT \
  CDFIR_EXPECTED_CONTAINERS \
  CDFIR_BACKUP_STAMP_FILE; do
  value="$(env_value "$key")"
  if [ -n "$value" ]; then
    env_args+=("$key=$value")
  fi
done

status=0
output="$(
  timeout --signal=TERM --kill-after=15s "${DEADLINE_SECONDS}s" \
    env "${env_args[@]}" "$NODE" "$CLI" 2>&1
)" || status=$?

{
  printf '%s exit=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status"
  printf '%s\n' "$output"
} >> "$LOG" 2>/dev/null || true

# Keep the log a fixed size. A monitor that fills the disk it watches would be a
# poor joke.
if [ -f "$LOG" ]; then
  trimmed="$(mktemp "${LOG}.XXXXXX" 2>/dev/null || true)"
  if [ -n "$trimmed" ]; then
    chmod 600 "$trimmed" 2>/dev/null || true
    if tail -n "$LOG_MAX_LINES" "$LOG" > "$trimmed" 2>/dev/null; then
      mv "$trimmed" "$LOG"
    else
      rm -f "$trimmed"
    fi
  fi
fi

# Only a bad run says anything, so mail from cron always means something.
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$output" >&2
fi
exit "$status"
