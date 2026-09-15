#!/usr/bin/env bash
# Tests for the live-state hooks. Run: .claude/hooks/live-state.test.sh
#
# These check the parts that must never break: the hook always emits valid JSON,
# always carries the rule, tells the truth about how old its data is, and degrades
# to "unreachable" instead of dying when a machine is gone.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0

ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; [ $# -gt 1 ] && printf '       %s\n' "$2"; }
check() { if [ "$2" = "yes" ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }
# A `case` pattern's own ")" would close a $( ) substitution, so match here.
has() { case "$1" in (*"$2"*) echo yes;; (*) echo no;; esac; }
has2() { if [ "$(has "$1" "$2")" = yes ] || [ "$(has "$1" "$3")" = yes ]; then echo yes; else echo no; fi; }

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

echo "1. injector with no snapshot at all (first prompt, machines unreachable)"
OUT=$(echo '{"prompt":"hi"}' | env \
  CDFIR_LIVE_STATE_DIR="$SANDBOX/empty" \
  CDFIR_PROD_HOST=cdfir-no-such-host-xyz \
  CDFIR_NEW_HOST=cdfir-no-such-host-xyz \
  "$HERE/inject-live-state.sh" 2>/dev/null)
rc=$?
check "exits 0 even when every machine is unreachable" \
      "$([ $rc -eq 0 ] && echo yes || echo no)" "exit was $rc"
check "emits parseable JSON" \
      "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1 && echo yes || echo no)" "$OUT"
CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""')
check "carries the standing rule" \
      "$(has "$CTX" "STANDING RULE")"
check "says the machines could not be reached, rather than inventing state" \
      "$(has2 "$CTX" "unreachable" "could not be collected")" "$CTX"

echo "2. collector against a dead host writes a cache, does not hang or die"
start=$(date +%s)
env CDFIR_LIVE_STATE_DIR="$SANDBOX/dead" \
    CDFIR_PROD_HOST=cdfir-no-such-host-xyz \
    CDFIR_NEW_HOST=cdfir-no-such-host-xyz \
    "$HERE/collect-live-state.sh" >/dev/null 2>&1
elapsed=$(( $(date +%s) - start ))
CACHE="$SANDBOX/dead/live-state.cache"
check "wrote a cache file" "$([ -s "$CACHE" ] && echo yes || echo no)"
check "finished inside 60s (took ${elapsed}s)" \
      "$([ "$elapsed" -lt 60 ] && echo yes || echo no)"
check "marks the unreachable host instead of guessing" \
      "$(grep -q 'unreachable' "$CACHE" && echo yes || echo no)" "$(cat "$CACHE" 2>/dev/null)"
check "still reports real local git state" \
      "$(grep -q '^MAC ' "$CACHE" && echo yes || echo no)"

echo "3. age is reported honestly, and a very old snapshot is refreshed first"
mkdir -p "$SANDBOX/mild"
# 300s old, well inside STALE_MAX: must be served as-is with its true age.
printf 'collected_at=stub\ncollected_epoch=%s\nMAC   stub\n' "$(( $(date +%s) - 300 ))" \
  > "$SANDBOX/mild/live-state.cache"
CTX=$(echo '{"prompt":"hi"}' | env \
  CDFIR_LIVE_STATE_DIR="$SANDBOX/mild" CDFIR_LIVE_STATE_STALE_MAX=600 \
  CDFIR_PROD_HOST=cdfir-no-such-host-xyz CDFIR_NEW_HOST=cdfir-no-such-host-xyz \
  "$HERE/inject-live-state.sh" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext')
mild_age=$(printf '%s' "$CTX" | sed -n 's/.*measured \([0-9]*\)s ago.*/\1/p' | head -1)
check "a 300s-old snapshot reports ~300s, not 0 (got ${mild_age:-none}s)" \
      "$([ "${mild_age:-0}" -ge 300 ] 2>/dev/null && echo yes || echo no)" "age was ${mild_age:-unset}"

mkdir -p "$SANDBOX/ancient"
# Years old: a background refresh would only help the NEXT prompt, so this one
# must wait for fresh data rather than answer with something hours stale.
printf 'collected_at=stub\ncollected_epoch=1\nMAC   stub\n' > "$SANDBOX/ancient/live-state.cache"
CTX=$(echo '{"prompt":"hi"}' | env \
  CDFIR_LIVE_STATE_DIR="$SANDBOX/ancient" CDFIR_LIVE_STATE_STALE_MAX=600 \
  CDFIR_PROD_HOST=cdfir-no-such-host-xyz CDFIR_NEW_HOST=cdfir-no-such-host-xyz \
  "$HERE/inject-live-state.sh" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext')
old_age=$(printf '%s' "$CTX" | sed -n 's/.*measured \([0-9]*\)s ago.*/\1/p' | head -1)
check "a years-old snapshot is refreshed before answering (now ${old_age:-none}s)" \
      "$([ "${old_age:-999999}" -lt 120 ] 2>/dev/null && echo yes || echo no)" "age was ${old_age:-unset}"
check "the refreshed snapshot replaced the stub" \
      "$(has2 "$CTX" "unreachable" "could not be collected")"
check "never claims to be live" "$(has "$CTX" "not live")"

echo "3b. the hook writes nothing to stderr (noise would pollute every prompt)"
ERR=$(echo '{"prompt":"hi"}' | env \
  CDFIR_LIVE_STATE_DIR="$SANDBOX/ancient" CDFIR_LIVE_STATE_STALE_MAX=600 \
  CDFIR_PROD_HOST=cdfir-no-such-host-xyz CDFIR_NEW_HOST=cdfir-no-such-host-xyz \
  "$HERE/inject-live-state.sh" 2>&1 >/dev/null)
check "stderr is empty" "$([ -z "$ERR" ] && echo yes || echo no)" "stderr said: $ERR"

echo "4. both scripts are valid shell and executable"
for f in collect-live-state.sh inject-live-state.sh; do
  check "$f parses"     "$(bash -n "$HERE/$f" 2>/dev/null && echo yes || echo no)"
  check "$f executable" "$([ -x "$HERE/$f" ] && echo yes || echo no)"
done

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
