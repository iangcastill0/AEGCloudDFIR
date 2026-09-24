# Monitoring

Two layers. The first tells you what broke. The second lets you look at what led
up to it.

## 1. Alerts (the important one)

`packages/monitoring` runs on the **host**, from cron, every 5 minutes, and
checks:

| Check        | Fails when                                                                |
| ------------ | ------------------------------------------------------------------------- |
| `api`        | `/readyz` is not 200, or the database, object storage or search is not ok |
| `site`       | `CDFIR_WEB_PUBLIC_URL` does not answer 2xx/3xx                            |
| `containers` | an expected container is missing, unhealthy, or restarting                |
| `disk`       | the host root filesystem is ≥ 90% full (warns at 80%)                     |
| `backup`     | the newest verified backup is older than 30 hours                         |
| `tls`        | the certificate expires within 7 days (warns at 21)                       |

Results go to a [healthchecks.io](https://healthchecks.io) check:

- all ok → pings the URL, and the check stays green
- any failure → pings `<url>/fail`, and healthchecks.io emails you
- **nothing arrives → healthchecks.io also emails you.** This is the part that
  matters most: if the host dies, or cron stops, or the checker crashes, silence
  is treated as failure. An alarm inside the building cannot ring after the
  building loses power.

Warnings (disk at 80%, cert at 21 days) are reported but do **not** page. An
alert that fires for something you cannot act on today trains you to ignore
alerts.

### It runs on the host, and that is not an accident

Three of the six checks are facts about the **host**: `df -h /`, `docker ps`, and
`docker system df`. Run the same code inside a container and `df -h /` measures
that container's own, nearly empty filesystem. The alert then reads
`root filesystem 4% used` every five minutes while the real disk fills. That is
worse than having no monitor, because it removes the reason to look.

The other way round is worse still. To let a container ask `docker ps`, you have
to mount `/var/run/docker.sock` into it, and that hands the container
root-equivalent control of the whole machine — every evidence volume included.
`:ro` does not help: it protects the file, not the API behind it. This repo
already refused that trade once, for cAdvisor (see the bottom of this page).

Running as root cron on the host needs no such grant. Root cron can already see
everything, and the checker only reads.

Both halves are pinned by tests in `packages/monitoring/src/host.test.ts`, which
read `scripts/monitor.sh` and `infra/cron/cdfir-monitor` and fail if either one
ever grows a `docker run`. Pinning the values alone was not enough — an
`process.env.CDFIR_DISK_PATH ?? '/'` knob still reads `/` in every test and a
container path in production, so `checks.ts` is now forbidden to read the
environment at all.

### What the exit code means

`scripts/monitor.sh` writes every run to `/var/log/cdfir-monitor.log` with the
exit code on the first line. A healthy run prints nothing anywhere else, so any
mail from cron means something.

| Exit | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | everything ok, and the switch was told so                         |
| 1    | a check failed, and `/fail` was pinged                            |
| 2    | `CDFIR_HEALTHCHECK_PING_URL` is not set — **nobody was notified** |
| 3    | every check ran, but the ping could not be delivered              |
| 70   | this host is not set up (no node, no built checker, no `.env`)    |
| 75   | the previous run is still going, so this one was skipped          |

Code 2 exists because the old behaviour was worse than useless: with no ping URL
the checker found everything healthy, said "nothing was notified", and exited 0.
That looks installed and tells nobody.

## Setting it up on a fresh host

Do these in order. The checker cannot run until the production deploy has put it
on the host, so the cron entry goes in last.

### Step 1 — [BROWSER] make the check and copy its URL

You create this URL, and you are the only one who ever sees it. Treat it like a
password: anyone holding it can post a fake "ok" and mute every alarm.

1. Sign in to <https://healthchecks.io>.
2. **Add Check**. Name it `cdfir-prod`.
3. Set **Period** to `5 minutes` and **Grace** to `15 minutes`. Do this, or its
   default period is a whole day and a dead server goes unreported for hours.
4. Add an email integration, and send yourself a test.
5. Copy the ping URL.

### Step 2 — [LINODE] put the URL in `.env`

This never echoes the URL and never leaves it in your shell history. It keeps
`.env` at mode 0600, and it is safe to run again if you paste the wrong thing.

```bash
cd /var/www/AEGCloudDFIR
read -rsp 'paste the ping URL: ' HC && printf '\n'
grep -v '^CDFIR_HEALTHCHECK_PING_URL=' .env > .env.new \
  && printf 'CDFIR_HEALTHCHECK_PING_URL=%s\n' "$HC" >> .env.new \
  && chmod 600 .env.new && mv .env.new .env && unset HC
grep -c '^CDFIR_HEALTHCHECK_PING_URL=' .env   # expect exactly 1
```

No quotes around the value — see the gotcha at the bottom of this page.

### Step 3 — [LINODE] install node

The checker is JavaScript, and the host has no node. It needs node 18 or newer
for `fetch`; use 22 so it matches what the containers run.

Check what you have first:

```bash
. /etc/os-release && echo "$PRETTY_NAME"
command -v node || echo 'no node'
apt-cache policy nodejs | head -3
```

If Ubuntu's own `nodejs` is 18 or newer, that is the simplest choice, and it
gets security updates from the distribution:

```bash
apt-get update && apt-get install -y nodejs
node --version
```

If it is older, use NodeSource's signed apt repository. Download the script and
read it before you run it — it adds an apt source and a signing key:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh && apt-get install -y nodejs
node --version && rm -f /tmp/nodesource_setup.sh
```

A signed apt repo is the point: `apt upgrade` then patches node like anything
else. A hand-unpacked tarball from nodejs.org also works, and never gets patched
again, which is why it is not the recommendation here.

### Step 4 — ship the code, then prove it by hand

The checker is built into the **api image** and lifted out onto the host by
`scripts/deploy.sh`. So it arrives with a normal production deploy and nothing
extra:

1. Merge to `main`, wait for CI and **Release images** (~15 minutes).
2. Run **Deploy staging**, and look at staging.
3. Run **Deploy** (production). Its log now has a line like
   `health checker installed from ghcr.io/…/api:sha-1a2b3c4`.

Then run it once yourself. This is the whole point of a manual run: you see the
findings and the exit code before cron starts hiding them in a log.

```bash
/var/www/AEGCloudDFIR/scripts/monitor.sh; echo "exit=$?"
tail -n 20 /var/log/cdfir-monitor.log
```

Expect `exit=0`, and the check turns green in healthchecks.io within a second or
two.

`exit=2` means step 2 did not take. `exit=70` means node or the built checker is
missing, and the log line says which.

**`[FAIL] backup: no backup found` is normal until the first backup runs.** Put
the backup cron in first if you want a quiet start; otherwise the checker pings
`/fail` every five minutes, truthfully, until tomorrow morning. The backup cron
line **must `cd` into the repo**, because `scripts/backup-postgres.sh` reads
`.env` and the compose file by relative path:

```
15 3 * * * root cd /var/www/AEGCloudDFIR && ./scripts/backup-postgres.sh >> /var/log/cdfir-backup.log 2>&1
```

### Step 5 — [LINODE] install the schedule

One non-interactive command. Nothing is typed into an editor, and running it
again is harmless.

```bash
install -o root -g root -m 0644 \
  /var/www/AEGCloudDFIR/infra/cron/cdfir-monitor /etc/cron.d/cdfir-monitor
cat /etc/cron.d/cdfir-monitor
systemctl is-active cron
```

Why `/etc/cron.d` and not `crontab -e`: it is a plain file, so installing it is
one repeatable command, and `cat` shows exactly what is scheduled. A root crontab
is invisible until you ask for it, and this monitoring went missing precisely
because the 2026-09-15 move to the Linode carried the code across and left the
schedule behind.

Two rules about that file, and breaking either makes cron **ignore it in
silence**: the filename must have no dot in it, and the file must end with a
newline. Tests pin both, because "silently ignored" is the one thing a
dead-man's switch cannot tell apart from a dead host.

### Step 6 — watch one real cycle

Wait six minutes, then:

```bash
tail -n 20 /var/log/cdfir-monitor.log
grep CRON /var/log/syslog | tail -5
```

And in [BROWSER] healthchecks.io, the check should be green with a "last ping"
under five minutes old. That is the moment it is actually working. A green
`pnpm test` never meant this.

## What a disk alert tells you now

A disk warning or failure names the biggest thing you can delete, not just the
percentage:

```
[FAIL] disk: root filesystem 96% used — docker: 25.1 GB reclaimable
```

That second half was added after a real outage. On 2026-08-27 the disk filled to
100% and PostgreSQL on staging crashed. It then could not restart, because
replaying its own write-ahead log also needs space. The monitor was working
perfectly: it had said `root filesystem 96% used` every five minutes for over
five hours. It just never said what to do, so nobody did anything.

To act on one:

```bash
ssh cdfir-linode 'docker system df; df -h /'
```

Then reclaim, biggest first:

```bash
ssh cdfir-linode 'docker image prune -a -f'
```

Old image tags should no longer be the cause. Both deploy scripts delete them
after a healthy deploy — see `docs/runbooks/deploy.md`.

## How the checker gets onto the host

It has no runtime dependencies, so it is compiled into the **api image**
(`infra/docker/api.Dockerfile`) as a passenger, and `scripts/deploy.sh` copies it
out with `docker create` plus `docker cp`. `docker create` makes a container
without starting one, purely so there is something to copy from.

Three things follow from doing it that way, and each one is why:

- **The host never builds it.** There is no pnpm there, and building on the
  server is what filled its disk once already.
- **Every deploy path delivers it** — the production workflow, or a hand-run
  `./scripts/deploy.sh`. It used to be an `scp` step inside `deploy.yml`, which
  covered only one of those. Two delivery routes for one file is how a monitor
  ends up silently stale.
- **Staging deliberately does not touch it.** Both stacks share this one
  checkout, so letting a staging deploy write here would let an older commit
  quietly downgrade the checker that watches production.

If the copy fails, the deploy says so and carries on. A checker one version
behind is a smaller problem than refusing to ship a fix, and it keeps pinging, so
nothing switches off.

`packages/monitoring/package.json` must stay on the host, because it is what
makes node read `dist/cli.js` as a module. It is tracked in git, so every deploy
restores it.

## 2. Dashboards

Prometheus, Grafana and node-exporter live in the `monitoring` compose profile,
so they do not start with the normal stack:

```bash
cd /var/www/AEGCloudDFIR/infra/compose && docker compose --env-file ../../.env --profile monitoring up -d
```

Everything binds to `127.0.0.1` only. To look at Grafana, tunnel to it — run
this on your **Mac**, then open <http://localhost:53000>:

```bash
ssh -N -L 53000:127.0.0.1:53000 cdfir-linode
```

Log in as `admin`. Read the password on the **host** (never committed):

```bash
grep CDFIR_GRAFANA_ADMIN_PASSWORD /var/www/AEGCloudDFIR/.env
```

The dashboard **CloudDFIR overview** is provisioned from
`infra/monitoring/grafana/dashboards/overview.json`: disk, memory, CPU, load,
plus the worker's jobs per minute, outbox backlog, dead-lettered jobs and
heartbeat. The worker has exported those all along with nothing scraping it.

Prometheus keeps 15 days, capped at 4 GB — long enough to see a trend, short
enough not to become the next disk problem.

This is the second layer, and it is **not** alerting. It only helps once you are
already looking, and it is bound to localhost, so nothing here can page you.

## What is deliberately not here

- **No cAdvisor** (per-container CPU/memory). It needs the Docker socket, and
  mounting that socket gives root-equivalent control of the host even mounted
  `:ro` — `:ro` protects the file, not the API behind it. Container liveness is
  covered by the `containers` check instead, which reads the same information
  from the host, where the permission already exists.
- **No socket proxy either.** A read-only proxy in front of the socket would
  shrink what a container can do, but it is one more long-running component that
  itself has to be watched, and it still holds the real socket. Running on the
  host needs none of it.
- **No Alertmanager.** Alerting is the checker plus healthchecks.io; adding a
  second alerting path would mean two places to configure and two to trust.
- **No metrics from the api yet.** Only the worker exposes `/metrics`. The api's
  health is covered by the `api` check, which includes search.
- **No staging switch.** One dead-man's switch, and it watches production.
  Staging is restarted and broken all day, so a switch on it would page for
  things nobody intends to fix — and an alert you learn to ignore is worse than
  no alert. If you ever want one, make a second check and point the wrapper at
  the other env file with `CDFIR_MONITOR_ENV_FILE`.

## Gotcha: do not quote values in `.env`

Write `KEY=value`, not `KEY='value'`. Compose passes surrounding quotes through
into the value — the Grafana admin password was set to a string that literally
contained quote characters, and logging in failed until it was rewritten bare.
Only quote a value that genuinely contains spaces, and remember that anything
sourcing `.env` as shell will see those quotes differently again.

`scripts/monitor.sh` reads `.env` one key at a time with `grep`, and never
sources it. Sourcing runs the file as a shell script, so a single line the shell
dislikes takes the whole thing down — that has happened here, when an unquoted
SSH host key parsed as a command name and the nightly backup stopped without a
word. The wrapper also hands the checker only the five settings it needs, so a
process that posts to a third party never holds a database or storage credential.
