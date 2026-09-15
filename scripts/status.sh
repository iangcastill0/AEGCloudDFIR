#!/usr/bin/env bash
# Plain-English health and performance check. Read-only: it starts, stops and
# changes nothing. Run it on the host that serves the app.
#
#   /var/www/AEGCloudDFIR/scripts/status.sh
#
# Every line says OK, BUSY or PROBLEM so you do not have to interpret numbers.
set -u
cd "$(dirname "$0")/.." 2>/dev/null || true

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'
[ -t 1 ] || { G=""; Y=""; R=""; B=""; N=""; }
row() { printf "  %-14s %b%-11s%b %s\n" "$1" "$3" "$2" "$N" "$4"; }

echo
echo "${B}CloudDFIR — $(hostname) — $(date -u '+%a %d %b %H:%M UTC')${N}"
echo

# ---- is the site actually answering ---------------------------------------
# -k because we connect to 127.0.0.1 while claiming the public hostname; the
# certificate is real, it just does not cover the loopback address.
web=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: app.aegclouddfir.com' https://127.0.0.1/ 2>/dev/null)
ready=$(curl -sk --max-time 10 -H 'Host: api.aegclouddfir.com' https://127.0.0.1/readyz 2>/dev/null)
case "$ready" in
  *'"status":"ok"'*) row "Website" "UP" "$G" "app $web, and the API says everything it needs is reachable" ;;
  *'"status"'*)      row "Website" "PARTLY" "$Y" "app $web, but: $(echo "$ready" | tr -d '{}"' | cut -c1-90)" ;;
  *)                 row "Website" "DOWN" "$R" "the API did not answer at all" ;;
esac

# ---- containers ------------------------------------------------------------
pu=$(docker ps --filter 'label=com.docker.compose.project=cdfir' -q 2>/dev/null | wc -l)
pt=$(docker ps -a --filter 'label=com.docker.compose.project=cdfir' -q 2>/dev/null | wc -l)
su=$(docker ps --filter 'label=com.docker.compose.project=cdfir-staging' -q 2>/dev/null | wc -l)
st=$(docker ps -a --filter 'label=com.docker.compose.project=cdfir-staging' -q 2>/dev/null | wc -l)
sick=$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
if [ -n "$sick" ]; then row "Containers" "PROBLEM" "$R" "unhealthy: $sick"
else row "Containers" "OK" "$G" "$pu of $pt live, $su of $st staging"; fi

# ---- how busy the machine is ----------------------------------------------
cores=$(nproc); load=$(awk '{print $1}' /proc/loadavg)
pct=$(awk -v l="$load" -v c="$cores" 'BEGIN{printf "%.0f", l/c*100}')
if   [ "$pct" -lt 80  ]; then row "Busy-ness" "OK" "$G" "load $load on $cores cores — room to spare"
elif [ "$pct" -lt 150 ]; then row "Busy-ness" "FULL" "$Y" "load $load on $cores cores — using all of it, nothing wasted"
else row "Busy-ness" "OVERLOADED" "$R" "load $load on $cores cores — ${pct}% of capacity, work is queueing up"; fi

# ---- memory: swapping is the thing that actually hurts ---------------------
mem=$(free -g | awk 'NR==2{printf "%s of %s GB", $3, $2}')
swap=$(free -m | awk 'NR==3{print $3}')
if [ "${swap:-0}" -gt 256 ]; then row "Memory" "PROBLEM" "$R" "$mem, and swapping ${swap} MB — this makes everything slow"
else row "Memory" "OK" "$G" "$mem used, not swapping"; fi

# ---- disk ------------------------------------------------------------------
dp=$(df / | awk 'NR==2{gsub(/%/,"");print $5}'); dh=$(df -h / | awk 'NR==2{print $3" of "$2}')
if   [ "$dp" -ge 90 ]; then row "Disk" "PROBLEM" "$R" "$dh (${dp}%) — search goes read-only near full"
elif [ "$dp" -ge 80 ]; then row "Disk" "WATCH" "$Y" "$dh (${dp}%)"
else row "Disk" "OK" "$G" "$dh (${dp}%)"; fi

# ---- the work backlog, measured rather than guessed ------------------------
q() { docker exec cdfir-redis-1 redis-cli LLEN "bull:$1:wait" 2>/dev/null || echo 0; }
ex=$(q process.extract); oc=$(q process.ocr); left=$((ex + oc)); now=$(date +%s)
STAMP=/var/tmp/cdfir-status-last

# A short sample is worthless here — jobs finish in bursts, and a 10-second
# window once read 2,520/hour against a true 576/hour. So compare against the
# last time this ran instead.
prev=""; [ -r "$STAMP" ] && prev=$(cat "$STAMP" 2>/dev/null)
printf '%s %s\n' "$now" "$ex" > "$STAMP" 2>/dev/null

if [ "$left" -eq 0 ]; then
  row "Work queue" "EMPTY" "$G" "nothing waiting"
elif [ -n "$prev" ]; then
  pt=${prev%% *}; pe=${prev##* }; dt=$((now - pt)); de=$((pe - ex))
  if [ "$dt" -lt 120 ]; then
    row "Work queue" "$(printf "%'d" $left)" "$G" "items waiting — last check was only $((dt))s ago, too soon for a rate"
  elif [ "$de" -gt 0 ]; then
    rate=$(( de * 3600 / dt )); hrs=$(( ex / (rate>0?rate:1) ))
    row "Work queue" "WORKING" "$G" "$(printf "%'d" $left) waiting, ~$(printf "%'d" $rate)/hour over the last $((dt/60)) min → about $((hrs/24)) days"
  else
    row "Work queue" "NOT MOVING" "$Y" "$(printf "%'d" $left) waiting, none finished in $((dt/60)) min"
  fi
else
  row "Work queue" "$(printf "%'d" $left)" "$G" "items waiting — run this again in a few minutes to get a rate"
fi

# ---- certificates ----------------------------------------------------------
if command -v certbot >/dev/null 2>&1; then
  d=$(certbot certificates 2>/dev/null | grep -o 'VALID: [0-9]*' | awk '{print $2}' | sort -n | head -1)
  if   [ -z "$d" ];      then row "Certificates" "UNKNOWN" "$Y" "could not read certbot"
  elif [ "$d" -lt 14 ];  then row "Certificates" "PROBLEM" "$R" "soonest expiry in $d days — renewal may be broken"
  else row "Certificates" "OK" "$G" "soonest expiry in $d days"; fi
fi
echo
