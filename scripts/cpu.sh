#!/usr/bin/env bash
# Who is using the CPU, in plain language. Read-only.
#
#   /var/www/AEGCloudDFIR/scripts/cpu.sh
#
# Docker reports container CPU as a percentage of ONE core, so 349% means the
# container is keeping about three and a half cores busy. This converts that to
# cores, because "349%" on an 8-core box is easy to misread as "nearly full".
set -u
CORES=$(nproc)

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; B=$'\033[1m'; N=$'\033[0m'
[ -t 1 ] || { G=""; Y=""; R=""; D=""; B=""; N=""; }

bar() { # bar <percent-of-machine> <width>
  local p=$1 w=${2:-24} f i out=""
  f=$(awk -v p="$p" -v w="$w" 'BEGIN{n=int(p*w/100); print (n>w?w:(n<0?0:n))}')
  for ((i=0;i<f;i++)); do out+="█"; done
  for ((i=f;i<w;i++)); do out+="·"; done
  printf '%s' "$out"
}

# True machine-wide usage, sampled over 3 seconds from /proc/stat. This is the
# number to trust: docker stats only sees containers, not the host itself.
read -r _ u1 n1 s1 i1 w1 rest < /proc/stat; t1=$((u1+n1+s1+i1+w1))
sleep 3
read -r _ u2 n2 s2 i2 w2 rest < /proc/stat; t2=$((u2+n2+s2+i2+w2))
dt=$((t2-t1)); di=$((i2-i1)); dw=$((w2-w1))
busy=$(awk -v dt="$dt" -v di="$di" 'BEGIN{printf "%.0f", (dt-di)*100/dt}')
iowait=$(awk -v dt="$dt" -v dw="$dw" 'BEGIN{printf "%.1f", dw*100/dt}')
used=$(awk -v b="$busy" -v c="$CORES" 'BEGIN{printf "%.1f", b*c/100}')

echo
echo "${B}CPU on $(hostname) — $CORES cores — $(date -u '+%H:%M UTC')${N}"
echo
col=$G; [ "$busy" -ge 75 ] && col=$Y; [ "$busy" -ge 92 ] && col=$R
printf "  Machine   %b%s%b %s%%   %s of %s cores busy\n" "$col" "$(bar "$busy" 28)" "$N" "$busy" "$used" "$CORES"
printf "  ${D}waiting on disk: %s%%  (high here would mean storage, not CPU, is the limit)${N}\n" "$iowait"
echo
echo "  ${B}Which containers${N}  ${D}(share of the whole machine)${N}"

docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}' 2>/dev/null \
| sed 's/%//' | sort -t'|' -k2 -nr | head -12 | while IFS='|' read -r name pc; do
    [ -z "${pc:-}" ] && continue
    share=$(awk -v p="$pc" -v c="$CORES" 'BEGIN{printf "%.0f", p/c}')
    cores=$(awk -v p="$pc" 'BEGIN{printf "%.1f", p/100}')
    case "$name" in *staging*) tag="${D}staging${N}";; *) tag="live";; esac
    awk -v p="$pc" 'BEGIN{exit !(p<1)}' && continue   # hide the idle ones
    printf "    %-26s %s %3s%%  %4s cores  %b\n" "$name" "$(bar "$share" 16)" "$share" "$cores" "$tag"
  done

echo
p=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null | grep -v staging | awk '{gsub(/%/,"");s+=$2} END{printf "%.0f", s}')
t=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null | grep    staging | awk '{gsub(/%/,"");s+=$2} END{printf "%.0f", s}')
printf "  Production %s cores   Staging %s cores   Ceiling %s cores\n" \
  "$(awk -v v="$p" 'BEGIN{printf "%.1f", v/100}')" \
  "$(awk -v v="$t" 'BEGIN{printf "%.1f", v/100}')" "$CORES"

load=$(awk '{print $1}' /proc/loadavg)
q=$(awk -v l="$load" -v c="$CORES" 'BEGIN{printf "%.1f", l-c}')
echo
if awk -v l="$load" -v c="$CORES" 'BEGIN{exit !(l>c*1.5)}'; then
  echo "  ${R}Queueing:${N} load $load against $CORES cores — roughly $q jobs' worth of work"
  echo "  ${D}is waiting for a core at any moment. More cores would help; settings will not.${N}"
elif awk -v l="$load" -v c="$CORES" 'BEGIN{exit !(l>c*0.8)}'; then
  echo "  ${Y}Fully used:${N} load $load against $CORES cores — using the machine, not drowning."
else
  echo "  ${G}Spare capacity:${N} load $load against $CORES cores."
fi
echo
