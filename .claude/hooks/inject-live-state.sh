#!/usr/bin/env bash
# UserPromptSubmit hook: put the standing "check, do not guess" rule and a fresh
# snapshot of the real machines in front of Claude on EVERY prompt.
#
# The harness runs this, not Claude, so the rule cannot be forgotten, skipped or
# lost to compaction. Always exits 0 and always prints valid JSON — a broken
# hook must never block a prompt.
set -u

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${CDFIR_LIVE_STATE_DIR:-$HOME/.claude/projects/-Users-ic-Documents-CloudDiscovery}"
CACHE="$CACHE_DIR/live-state.cache"
TTL="${CDFIR_LIVE_STATE_TTL:-90}"   # seconds before the snapshot counts as stale

read -r -d '' RULE <<'RULE_TEXT'
=== STANDING RULE — CloudDiscovery (injected every turn by a hook; never expires) ===
Do NOT describe the state of CI, a deploy, an image tag, a container, a queue, a
database, a disk, or either server from memory, from inference, or from an earlier
turn in this conversation. Those guesses have been wrong in both directions here.

Before you make such a statement, run the command in THIS turn and quote what came
back. If you have not run it, the honest answer is "I have not checked yet" —
say that instead of estimating, and then go check.

The snapshot below is a starting point, not a substitute. It is a few seconds to a
few minutes old and covers only the fields shown. Anything outside it — logs, rows,
queue depth, a specific collection, a specific job — still needs its own command.
Label every command [MAC], [SERVER] or [BROWSER].
RULE_TEXT

# Run the collector, but never let it hold a prompt longer than 25s.
collect_bounded() {
  "$HOOK_DIR/collect-live-state.sh" >/dev/null 2>&1 &
  local collector=$!
  { sleep 25; kill -9 "$collector"; } >/dev/null 2>&1 &
  local killer=$!
  wait "$collector" 2>/dev/null
  kill -9 "$killer" >/dev/null 2>&1
  wait "$killer" 2>/dev/null   # reap quietly; otherwise bash prints "Killed: 9"
}

emit() {  # emit <text> — wrap as UserPromptSubmit additionalContext and exit
  printf '%s' "$1" | jq -Rs \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:.},
      suppressOutput:true}' 2>/dev/null \
    || printf '{"suppressOutput":true}'
  exit 0
}

# No snapshot at all (first prompt of a session): collect one now, but give up
# after 25s rather than hold the prompt hostage.
if [ ! -s "$CACHE" ]; then
  collect_bounded
fi

if [ ! -s "$CACHE" ]; then
  emit "$RULE

LIVE STATE: could not be collected. Nothing is known about the servers right now.
Do not describe them. Run the checks yourself, or say the machines are unreachable."
fi

then_epoch=$(sed -n 's/^collected_epoch=//p' "$CACHE" | head -1)
now_epoch=$(date +%s)
age=$(( now_epoch - ${then_epoch:-0} ))
[ "${then_epoch:-0}" -eq 0 ] 2>/dev/null && age="?"

# Mildly stale: refresh in the background so the NEXT prompt is fresh, and serve
# the current snapshot now with its true age attached. Never claim it is newer.
#
# Very stale (a long gap between prompts) is different: a background refresh only
# helps the next prompt, so this one would arrive hours old and be nearly useless.
# Past STALE_MAX, wait for a fresh collect instead.
STALE_MAX="${CDFIR_LIVE_STATE_STALE_MAX:-600}"
if [ "$age" = "?" ] || [ "$age" -ge "$STALE_MAX" ]; then
  collect_bounded
  then_epoch=$(sed -n 's/^collected_epoch=//p' "$CACHE" | head -1)
  age=$(( $(date +%s) - ${then_epoch:-0} ))
elif [ "$age" -ge "$TTL" ]; then
  ( "$HOOK_DIR/collect-live-state.sh" >/dev/null 2>&1 & ) >/dev/null 2>&1
fi

snapshot=$(grep -v '^collected_epoch=' "$CACHE")

emit "$RULE

=== LIVE STATE (measured ${age}s ago — not live, and only these fields) ===
$snapshot

Read it as: MAC = this laptop and its git; CI = GitHub Actions; PROD and STG =
production and staging, BOTH now on the Linode (ssh alias cdfir-linode, hostname
cdfir-prod) since the 2026-09-15 migration; HOST = that live host; OLD =
cdfir-server, retired and kept only as a rollback target; CERT = TLS expiry."
