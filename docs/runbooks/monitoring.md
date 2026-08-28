# Monitoring

Two layers. The first tells you what broke; the second lets you look at what led
up to it.

## 1. Alerts (the important one)

`packages/monitoring` runs on the server every 5 minutes from cron and checks:

| Check        | Fails when                                                                |
| ------------ | ------------------------------------------------------------------------- |
| `api`        | `/readyz` is not 200, or the database, object storage or search is not ok |
| `site`       | `https://app.aegclouddfir.com` does not answer 2xx/3xx                    |
| `containers` | an expected container is missing, unhealthy, or restarting                |
| `disk`       | root filesystem ≥ 90% (warns at 80%)                                      |
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
ssh cdfir-server 'docker system df; df -h /'
```

Then reclaim, biggest first:

```bash
ssh cdfir-server 'docker image prune -a -f'
```

Old image tags should no longer be the cause. Both deploy scripts now delete
them after a healthy deploy — see `docs/runbooks/deploy.md`.

**Set the schedule in healthchecks.io** so silence is actually noticed: Period
`5 minutes`, Grace `15 minutes`. Without that, its default period is a day and a
dead server would go unreported for hours.

Run it by hand any time:

```bash
cd /var/www/AEGCloudDFIR && node --env-file=.env packages/monitoring/dist/cli.js
```

Log: `~/cdfir-monitor.log` on the server, trimmed to the last 500 lines.

### Why the checker is compiled elsewhere

It has no runtime dependencies, so CI builds it and `deploy.yml` copies the `.js`
files to the server on every deploy. The server has no pnpm, and building there
is what filled its disk. Because the deploy re-ships it every time, it cannot
drift from the source in this repo.

## 2. Dashboards

Prometheus, Grafana and node-exporter live in the `monitoring` compose profile,
so they do not start with the normal stack:

```bash
cd /var/www/AEGCloudDFIR/infra/compose && docker compose --env-file ../../.env --profile monitoring up -d
```

Everything binds to `127.0.0.1` only. To look at Grafana, tunnel to it — run
this on your **Mac**, then open <http://localhost:53000>:

```bash
ssh -N -L 53000:127.0.0.1:53000 cdfir-server
```

Log in as `admin`. Read the password on the **server** (never committed):

```bash
grep CDFIR_GRAFANA_ADMIN_PASSWORD /var/www/AEGCloudDFIR/.env
```

The dashboard **CloudDFIR overview** is provisioned from
`infra/monitoring/grafana/dashboards/overview.json`: disk, memory, CPU, load,
plus the worker's jobs per minute, outbox backlog, dead-lettered jobs and
heartbeat. The worker has exported those all along with nothing scraping it.

Prometheus keeps 15 days, capped at 4 GB — long enough to see a trend, short
enough not to become the next disk problem.

## What is deliberately not here

- **No cAdvisor** (per-container CPU/memory). It needs the Docker socket, and
  mounting that socket gives root-equivalent control of the host even mounted
  `:ro` — `:ro` protects the file, not the API behind it. This box also runs an
  unrelated application. Container liveness is covered by the `containers` check
  instead.
- **No Alertmanager.** Alerting is the checker plus healthchecks.io; adding a
  second alerting path would mean two places to configure and two to trust.
- **No metrics from the api yet.** Only the worker exposes `/metrics`. The api's
  health is covered by the `api` check, which now includes search.

## Gotcha: do not quote values in `.env`

Write `KEY=value`, not `KEY='value'`. Compose passes surrounding quotes through
into the value — the Grafana admin password was set to a string that literally
contained quote characters, and logging in failed until it was rewritten bare.
Only quote a value that genuinely contains spaces, and remember that anything
sourcing `.env` as shell will see those quotes differently again.
