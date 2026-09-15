# Runbook: moving the whole application to a new server

Moving production from one host to another — the Azure VM to a Linode box, or
any replacement. Related: [backup-restore](backup-restore.md) for the dump
mechanics, [deploy](deploy.md) for how images reach a host.

## What actually moves

Far less than you would expect, because evidence is not on the server.

Volume sizes, measured 2026-09-15. Re-measure before you plan a window; these
grow. `docker system df -v` prints them.

| Store                 | Size    | Moves?                          |
| --------------------- | ------- | ------------------------------- |
| PostgreSQL (`cdfir`)  | 10.2 GB | yes                             |
| OpenSearch index      | 5.3 GB  | yes — copy it, do not rebuild   |
| **Redis**             | 462 MB  | **yes — see the warning below** |
| Authentik PostgreSQL  | 85 MB   | yes                             |
| Prometheus / Grafana  | 580 MB  | optional (metrics history)      |
| MinIO                 | 6.6 MB  | effectively empty               |
| **Evidence (Wasabi)** | —       | **no — it never lived here**    |

About 16 GB total. The evidence itself stays exactly where it is; the new host
just needs the same S3 credentials.

## Warning: Redis is NOT disposable during a migration

[disaster-recovery](disaster-recovery.md) says "Redis loss → safe, the outbox
re-dispatches". **That is true only for work not yet dispatched, and is
therefore false during a migration.**

The dispatcher marks an outbox row `dispatched` in the same transaction that
enqueues it. Once dispatched, it will never be re-enqueued — `(topic, dedupKey)`
is unique and dispatched rows are kept.

Measured on this host before a migration:

```
outbox pending          : 0
bull:process.extract    : 218,746 waiting
bull:process.ocr        :  26,957 waiting
```

Every one of those 245,703 jobs existed **only in Redis**. Dropping the volume
would have silently discarded days of text extraction and OCR, with nothing in
the database to say work was missing.

Check before you start:

```bash
docker exec -i cdfir-postgres-1 psql -U postgres -d cdfir \
  -tAc "SELECT count(*) FROM outbox_events WHERE status='pending'"
for q in process.extract process.ocr process.parse process.preview search.index; do
  printf "%s " "$q"; docker exec cdfir-redis-1 redis-cli LLEN "bull:$q:wait"
done
```

If the queues are non-empty, the Redis volume comes with you.

Re-measured 2026-09-15, while planning the Linode move: **0 pending in the
outbox against 244,984 waiting in Redis** (214,761 extract, 30,223 OCR). So this
is not a one-off from a single bad day — it is the normal state of a host that
is working through a large collection. Assume the queues are full and check
rather than the other way round.

## Rebuild OpenSearch, or copy it?

**Copy it.** Rebuilding is supported (`pnpm tsx scripts/reindex.ts`) but each
document is assembled from ~12 database queries plus a download of its extracted
text from Wasabi. At 480,989 documents that is many hours. Copying 5.3 GB is
minutes.

## 1. Prepare the new host

Provision Ubuntu 24.04. Attach a cloud firewall allowing **only** inbound
`22`, `80`, `443`. Everything else in this stack binds to `127.0.0.1` and must
stay that way.

```bash
# on the NEW host, as root
apt-get update && apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin nginx
mkdir -p /var/www && git clone https://github.com/iangcastill0/AEGCloudDFIR /var/www/AEGCloudDFIR
```

**Do not install pnpm and do not build images here.** CI builds them; the host
pulls. A build cache on this box once reached 48 GB and broke a deploy.

### Pull every image now, before the downtime window

Nothing here needs the old host, so it costs you nothing to do it days early. It
takes about 11 GB and 10 minutes off the clock later.

```bash
# NEW host. TAG is whatever production runs today — see step 2.
TAG=sha-xxxxxxx
cd /var/www/AEGCloudDFIR
grep -hE '^\s+image:' infra/compose/docker-compose.yml \
  | sed -E 's/^\s+image:\s*//' | sed "s/\${CDFIR_IMAGE_TAG:-dev}/$TAG/" | sort -u \
  | while read -r img; do docker pull -q "$img" || echo "FAILED $img"; done
```

**The MinIO images are no longer on Docker Hub.** Both `minio/minio` and
`minio/mc` now answer `pull access denied ... repository does not exist`, so that
pull fails on any new machine. They are not gone — they are still on the old
host, and copying them needs no login and no credentials:

```bash
# from your Mac, which can reach both. Writes to neither disk.
ssh cdfir-server 'docker save \
  minio/minio:RELEASE.2025-04-22T22-12-26Z \
  minio/mc:RELEASE.2025-04-16T18-13-26Z | gzip -1' \
  | ssh cdfir-linode 'gunzip | docker load'
```

**Pull `alpine` onto both hosts too.** The volume copy in step 3 and the restore
in step 4 both run `docker run --rm ... alpine tar`. Neither host had it before
the 2026-09-15 move, so each would have fetched it from Docker Hub mid-window —
the same registry already refusing the MinIO pulls above. 13 MB, and it removes
an anonymous Docker Hub fetch from your downtime:

```bash
ssh cdfir-server 'docker pull -q alpine'
ssh cdfir-linode 'docker pull -q alpine'
```

These two images now exist **only on your own servers**. A deploy prunes old
tags, keeping anything running — so they survive while MinIO is up. If MinIO is
ever stopped and pruned, they are unrecoverable. Save a copy somewhere.

## 2. Carry the secrets across by hand

`.env` holds `CDFIR_KEK_LOCAL_MASTER_KEY`. **Without it every connector
credential in the restored database is permanently undecryptable.** It is
deliberately not in any backup.

Copy `.env` from the old host to the new one yourself — password manager, or
`scp` directly between the two. Then set the image tag to whatever production is
currently running:

```bash
grep CDFIR_IMAGE_TAG /var/www/AEGCloudDFIR/.env    # on the OLD host
```

While you are in there, look at the new machine's concurrency. **Measure the box
first. Do not copy a number out of this file.**

```bash
nproc; free -g | awk 'NR==2{print $2" GB RAM"}'; df -h / | awk 'NR==2{print $2}'
```

The rule of thumb is about a quarter of the cores, so a 32-core box would take
`CDFIR_WORKER_CPU_CONCURRENCY=8`. It goes wrong in both directions:

- **Too low on a big box.** Left at the default of 4, a 32-core host runs the
  same four jobs at a time that a 5-core host did. The machine idles.
- **Too low on a small one.** The quarter rule can land _under_ the default. The
  2026-09-15 Linode move went from 5 cores to 8, where a quarter is **2** —
  which would have been slower than what was already running.

**Never set it below the value you run today.** If the new box wins on RAM and
disk rather than cores, say so and leave concurrency alone. That move gained
15 GB -> 31 GB of RAM and 98 GB -> 630 GB of disk, and only three cores. The disk
was the real reason to move; the CPU barely changed.

Symlink so either compose invocation works:

```bash
ln -sf /var/www/AEGCloudDFIR/.env /var/www/AEGCloudDFIR/infra/compose/.env
```

## 3. Stop the old host and take everything

Downtime starts here. Budget an hour.

**Check the old host's free space first, and do not write the dumps onto it.**

```bash
df -h /tmp        # /tmp is on / here, not its own filesystem
```

On 2026-09-15 that read `18G` free at 82% used, against dumps totalling roughly
7-10 GB. It would probably have fit. "Probably" is not good enough on the box
where a full disk once crashed PostgreSQL and then stopped it restarting,
because replaying the log also needs space.

So stream everything straight to the new host, which has the room. Nothing is
written to the old disk at any point. Run these **from your Mac**, which can
reach both machines:

```bash
# OLD host: flush the queues to disk, then stop the producers only.
ssh cdfir-server 'cd /var/www/AEGCloudDFIR \
  && docker exec cdfir-redis-1 redis-cli SAVE \
  && docker compose -f infra/compose/docker-compose.yml --env-file .env stop api web worker'

# Dumps: read on the old host, land on the new one.
ssh cdfir-server 'docker exec cdfir-postgres-1 pg_dump -U postgres -Fc -d cdfir' \
  | ssh cdfir-linode 'cat > /tmp/cdfir.dump'
ssh cdfir-server 'docker exec cdfir-authentik-postgres-1 pg_dump -U authentik -Fc -d authentik' \
  | ssh cdfir-linode 'cat > /tmp/authentik.dump'
ssh cdfir-linode 'ls -lh /tmp/*.dump'
```

A dump that streams to another machine cannot be checked afterwards on the box
it came from, so read the sizes on the new host and make sure neither is
suspiciously small before you tear the old stack down.

`pg_dump` **must run as a superuser**. Every tenant table carries
`FORCE ROW LEVEL SECURITY`, which applies to the owner too — a dump taken as
`cdfir` or `cdfir_migrator` produces a table of contents that looks complete
over data that is empty. `pg_restore --list` cannot detect it.

Now stop the rest and stream the volumes across the same way. Note there is no
`-v /tmp:/out` mount: the tar goes to stdout, so nothing lands on the old disk.

```bash
ssh cdfir-server 'cd /var/www/AEGCloudDFIR \
  && docker compose -f infra/compose/docker-compose.yml --env-file .env down'

for v in redis opensearch; do
  ssh cdfir-server "docker run --rm -v cdfir_${v}-data:/src alpine tar cz -C /src ." \
    | ssh cdfir-linode "cat > /tmp/${v}.tgz"
done
ssh cdfir-linode 'ls -lh /tmp/*.tgz'
```

Carry `cdfir_authentik-pg-data` the same way if you would rather move the volume
than restore the dump. `cdfir_prometheus-data` and `cdfir_grafana-data` are
optional — they are only metrics history, and skipping them saves 580 MB.

## 4. Restore on the new host

Bring up only the datastores first:

```bash
cd /var/www/AEGCloudDFIR
docker compose -f infra/compose/docker-compose.yml --env-file .env up -d \
  postgres redis opensearch minio authentik-postgres authentik-redis
sleep 20
```

Restore the volumes into the stopped containers:

```bash
docker compose -f infra/compose/docker-compose.yml --env-file .env stop redis opensearch
for pair in "cdfir_redis-data:/tmp/redis.tgz" "cdfir_opensearch-data:/tmp/opensearch.tgz"; do
  v="${pair%%:*}"; f="${pair#*:}"
  docker run --rm -v "$v":/dst -v /tmp:/in alpine \
    sh -c "rm -rf /dst/* && tar xzf /in/$(basename "$f") -C /dst"
done
docker compose -f infra/compose/docker-compose.yml --env-file .env start redis opensearch
```

Restore the databases:

```bash
docker exec -i cdfir-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS cdfir"
docker exec -i cdfir-postgres-1 psql -U postgres -c "CREATE DATABASE cdfir OWNER cdfir"
docker exec -i cdfir-postgres-1 pg_restore -U postgres -d cdfir --no-owner < /tmp/cdfir.dump
docker exec -i cdfir-authentik-postgres-1 pg_restore -U authentik -d authentik --clean --no-owner \
  < /tmp/authentik.dump
```

Apply any migrations the images expect. **This does not happen automatically**
— a missed migration has reached production as a bare 500 before:

```bash
docker compose -f infra/compose/docker-compose.yml --env-file .env \
  run --rm api pnpm --filter @aeg-clouddfir/database run migrate:deploy
```

## 5. Prove the restore before pointing DNS at it

Do not skip this. A restore that looks fine and is empty is the failure mode
this project has actually hit.

Run this on the **old** host before you stop it, write the numbers down, then
run it on the new one:

```bash
docker exec -i cdfir-postgres-1 psql -U postgres -d cdfir <<'SQL'
SELECT (SELECT count(*) FROM evidence_items)  AS evidence_items,
       (SELECT count(*) FROM collections)     AS collections,
       (SELECT count(*) FROM case_items)      AS case_items,
       (SELECT count(*) FROM audit_events)    AS audit_events;
SQL
```

Every number must match. For scale, on 2026-09-15 this host held
`evidence_items=480989`, `collections=6`, `case_items=478305`,
`audit_events=499326`. Those are a sanity check on the order of magnitude, not
your target — take your own baseline, because the counts move. Then:

```bash
# queues came across intact
docker exec cdfir-redis-1 redis-cli LLEN bull:process.extract:wait

# search index came across intact
docker exec cdfir-opensearch-1 sh -c \
  'curl -s -u admin:$OPENSEARCH_INITIAL_ADMIN_PASSWORD localhost:9200/_cat/indices/cdfir-*?v'
```

Start the application and check readiness — `/readyz` probes the database,
object storage **and** search, so it fails if any of the three is wrong:

```bash
docker compose -f infra/compose/docker-compose.yml --env-file .env up -d
sleep 30
docker exec cdfir-api-1 wget -qO- http://localhost:4000/readyz || echo "NOT READY"
```

Then, per [audit-verification](audit-verification.md):

```bash
pnpm audit:verify     # from your Mac against the new host; must exit 0
```

The audit chain is hash-linked. If it verifies after the restore, the evidence
record moved intact.

## 6. Cut over

1. Copy the nginx site configs from `infra/nginx/` and enable them.
2. Issue certificates: `certbot --nginx -d app.aegclouddfir.com -d api.aegclouddfir.com -d auth.aegclouddfir.com`.
   Port 80 must already be open inbound or the ACME challenge fails.
3. Lower the DNS TTL to 300s **the day before**, so a rollback is minutes.
4. Point the A records at the new IP.
5. Re-add cron: `scripts/backup-postgres.sh` at 03:15 UTC and the
   `packages/monitoring` check every 5 minutes. The monitor treats silence as an
   alert, so a forgotten cron reads as an outage — which is the correct
   behaviour, but confusing if you have forgotten why.
6. Update the healthchecks.io ping URL if the check is host-specific.

## Rollback

Until you have destroyed the old host, rollback is a DNS change. Keep the old
box powered off but intact for a week. Its stores are consistent as of the
moment you stopped it — the only thing lost by going back is whatever happened
on the new host in the meantime.

## After it settles

- Watch `uptime` and `docker stats` for an hour. On 32 cores with
  `CDFIR_WORKER_CPU_CONCURRENCY=8` the load average should sit near the core
  count, not six times it.
- Confirm the extract and OCR backlogs are actually draining:
  `docker exec cdfir-redis-1 redis-cli LLEN bull:process.ocr:wait`, twice, a
  minute apart. It must go **down**.
- Only then destroy the old host.
