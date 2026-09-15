#!/usr/bin/env bash
# Collect the real state of this project's machines into a cache file.
#
# Read-only. Never changes anything. Never hangs: every step is time-bounded and
# every failure becomes a "?" in the output instead of an error.
#
# Run by .claude/hooks/inject-live-state.sh, which feeds the result to Claude on
# every prompt so it reports measured state instead of guessing. See CLAUDE.md,
# "Never report pipeline or deployment state from inference — check it."
set -u

REPO="${CDFIR_REPO:-/Users/ic/Documents/CloudDiscovery}"
CACHE_DIR="${CDFIR_LIVE_STATE_DIR:-$HOME/.claude/projects/-Users-ic-Documents-CloudDiscovery}"
CACHE="$CACHE_DIR/live-state.cache"
# Overridable so tests can aim at a dead host and check the failure path.
# Production and staging BOTH moved to the Linode on 2026-09-15; cdfir-server is
# kept powered on only as a rollback target.
PROD_HOST="${CDFIR_PROD_HOST:-cdfir-linode}"
OLD_HOST="${CDFIR_OLD_HOST:-cdfir-server}"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5
          -o ServerAliveInterval=3 -o ServerAliveCountMax=2
          -o StrictHostKeyChecking=accept-new
          -o ControlMaster=auto -o ControlPath=/tmp/cdfir-mux-%r@%h:%p -o ControlPersist=10m)

# bound <seconds> <command...> — run it, print its stdout, kill it if it overruns.
# macOS has no `timeout`, so this is the portable stand-in.
bound() {
  local secs=$1; shift
  local out; out=$(mktemp) || return 1
  "$@" >"$out" 2>/dev/null &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" ) >/dev/null 2>&1 &
  local watcher=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill -9 "$watcher" >/dev/null 2>&1
  cat "$out"; rm -f "$out"
  return $rc
}

# ---------------------------------------------------------------- Mac / git ---
mac_line() {
  cd "$REPO" 2>/dev/null || { echo "MAC   ? repo not found at $REPO"; return; }
  local branch head dirty ahead
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  head=$(git rev-parse --short HEAD 2>/dev/null || echo '?')
  dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  ahead=$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo '?')
  local dirty_txt="clean"
  [ "$dirty" != "0" ] && dirty_txt="$dirty uncommitted file(s)"
  local push_txt="pushed"
  if [ "$ahead" = "?" ]; then push_txt="no upstream"
  elif [ "$ahead" != "0" ]; then push_txt="$ahead UNPUSHED commit(s) — a deploy cannot ship these"
  fi
  echo "MAC   $branch @$head, $dirty_txt, $push_txt"
}

# ------------------------------------------------------------------- GitHub ---
gh_one() {  # gh_one <workflow name> <label>
  local wf=$1 label=$2 json
  json=$(bound 10 gh run list --workflow="$wf" -L 1 \
           --json headSha,status,conclusion,createdAt 2>/dev/null)
  if [ -z "$json" ] || [ "$json" = "[]" ]; then
    echo "$label=? (gh unavailable)"; return
  fi
  # A workflow still running has conclusion "" (an empty string, not null), so
  # `//` does not fall through to .status. Test the length instead.
  echo "$json" | jq -r --arg l "$label" \
    '.[0] | (if (.conclusion // "" | length) > 0 then .conclusion else .status end) as $r
            | "\($l)=\($r) @\(.headSha[0:7]) \(.createdAt[0:16])"' \
    2>/dev/null || echo "$label=?"
}

# ------------------------------------------------------- Live server (prod) ---
REMOTE_PROBE='
cd /var/www/AEGCloudDFIR 2>/dev/null || { echo "REPO=missing"; exit 0; }
echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null)"
echo "PRODTAG=$(grep -h "^CDFIR_IMAGE_TAG" .env 2>/dev/null | head -1 | cut -d= -f2)"
echo "STGTAG=$(grep -h "^CDFIR_IMAGE_TAG" .env.staging 2>/dev/null | head -1 | cut -d= -f2)"
echo "DISK=$(df -h / | awk "NR==2{print \$5\" used, \"\$4\" free\"}")"
docker ps -a --format "C|{{.Label \"com.docker.compose.project\"}}|{{.Names}}|{{.State}}|{{.Status}}" 2>/dev/null
'

server_lines() {
  local raw; raw=$(bound 20 ssh "${SSH_OPTS[@]}" "$PROD_HOST" "$REMOTE_PROBE")
  if [ -z "$raw" ]; then
    echo "PROD  ? $PROD_HOST unreachable (ssh failed or timed out)"
    echo "STG   ? unreachable"
    return
  fi
  local head prodtag stgtag disk
  head=$(printf '%s\n'   "$raw" | sed -n 's/^HEAD=//p')
  prodtag=$(printf '%s\n' "$raw" | sed -n 's/^PRODTAG=//p')
  stgtag=$(printf '%s\n'  "$raw" | sed -n 's/^STGTAG=//p')
  disk=$(printf '%s\n'    "$raw" | sed -n 's/^DISK=//p')

  # One line per compose project: how many are up, and which are not.
  local proj
  for proj in cdfir cdfir-staging; do
    local rows up total down
    rows=$(printf '%s\n' "$raw" | awk -F'|' -v p="$proj" '$1=="C" && $2==p')
    total=$(printf '%s' "$rows" | grep -c . )
    up=$(printf '%s\n' "$rows" | awk -F'|' '$4=="running"' | grep -c . )
    down=$(printf '%s\n' "$rows" | awk -F'|' '$4!="running" && $3!="" {printf "%s(%s) ", $3, $4}')
    local sick
    sick=$(printf '%s\n' "$rows" | awk -F'|' '/unhealthy/ {printf "%s(unhealthy) ", $3}')
    local label tag
    if [ "$proj" = "cdfir" ]; then label="PROD "; tag="$prodtag"; else label="STG  "; tag="$stgtag"; fi
    # both now run on the live host
    if [ "$total" = "0" ]; then
      echo "$label tag=${tag:-?} — NO containers exist for compose project '$proj'"
    else
      local note=""
      [ -n "$down" ] && note=" DOWN: ${down% }"
      [ -n "$sick" ] && note="$note UNHEALTHY: ${sick% }"
      echo "$label tag=${tag:-?} — $up/$total containers running${note}"
    fi
  done
  echo "HOST  $PROD_HOST (live) checkout @${head:-?}, disk ${disk:-?}"
}

# ----------------------------------------------------------- Linode / new box ---
old_host_line() {
  local raw
  raw=$(bound 15 ssh "${SSH_OPTS[@]}" "$OLD_HOST" \
        'echo "H=$(hostname)"; echo "D=$(df -h / | awk "NR==2{print \$5}")"; echo "K=$(docker ps -q 2>/dev/null | wc -l | tr -d " ")"')
  if [ -z "$raw" ]; then echo "OLD   ? $OLD_HOST unreachable (rollback target)"; return; fi
  local h d k
  h=$(printf '%s\n' "$raw" | sed -n 's/^H=//p')
  d=$(printf '%s\n' "$raw" | sed -n 's/^D=//p')
  k=$(printf '%s\n' "$raw" | sed -n 's/^K=//p')
  echo "OLD   $OLD_HOST (${h:-?}) RETIRED rollback target — ${k:-0} containers up, disk ${d:-?}"
}

# TLS matters now that both environments are public on one host.
cert_line() {
  local out
  out=$(bound 15 ssh "${SSH_OPTS[@]}" "$PROD_HOST" \
        'certbot certificates 2>/dev/null | awk "/Certificate Name:/{n=\$3} /VALID:/{match(\$0,/VALID: [0-9]+/); printf \"%s %sd \", n, substr(\$0,RSTART+7,RLENGTH-7)}"')
  [ -z "$out" ] && { echo "CERT  ? could not read"; return; }
  echo "CERT  ${out% }"
}

# ----------------------------------------------------------------- Assemble ---
mkdir -p "$CACHE_DIR"
TMP=$(mktemp)
{
  echo "collected_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "collected_epoch=$(date +%s)"
  mac_line
  echo "CI    $(gh_one 'CI' 'CI') | $(gh_one 'Release images' 'Release')"
  server_lines
  old_host_line
  cert_line
} >"$TMP" 2>/dev/null
mv "$TMP" "$CACHE"
