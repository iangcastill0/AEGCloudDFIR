# Runbook: moving the whole application to a new server

Moving production from one host to another — the Azure VM to a Linode box, or
any replacement. Related: [backup-restore](backup-restore.md) for the dump
mechanics, [deploy](deploy.md) for how images reach a host.

## Read this before you start anything

**Put `.env` on the new host before you start a single container.** Postgres,
OpenSearch and Authentik's Postgres each read their passwords from `.env` on
their **first** start and bake them into the volume. Start them without it and
all three permanently carry compose's `changeme-local-only` default, while the
app reads the real values from `.env` and cannot log in. Symptoms are three
different failures that look unrelated:

| Container          | What you see                                        |
| ------------------ | --------------------------------------------------- |
| `api`, `worker`    | `P1000: Authentication failed ... cdfir_migrator`   |
| `opensearch`       | `/readyz` -> `search: unreachable (ResponseError)`  |
| `authentik-server` | `PostgreSQL connection failed, retrying...` forever |

This happened on the 2026-09-15 move and cost about an hour. The main database
had to be repaired in place (below); the other two volumes were empty and were
simply recreated.

The order that works:

1. `.env` on the new host, verified non-empty
2. then start containers
3. then restore data

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

### Checked 2026-09-15: nothing re-queues this work

The obvious hope is that something notices the gap and re-drives it. It does
not. `StalledItemSweeper` (`apps/worker/src/stalled-item-sweeper.ts`) runs every
120 seconds and looks like the answer, but it is for a different pipeline:

- It iterates **collection items**, and re-queues only `collectionFetchItem` or
  `searchIndex`. It never enqueues `processExtract` or `processOcr` — those are
  chained from `process-parse.ts:357` and `process-extract.ts:238`, which only
  run when the stage before them runs.
- It acts only on states `discovered`, `fetching` and `preserved`
  (`stalled-items.ts:52`). Anything already `indexed` is treated as settled.

Measured against the real backlog, of 200,341 items with
`processingStatus = 'pending'`:

|                                                | items   | why the sweeper misses them                                 |
| ---------------------------------------------- | ------- | ----------------------------------------------------------- |
| attachment children, no `collection_items` row | 197,641 | it iterates collection items, so it cannot see these at all |
| have a `collection_items` row, state `indexed` | 2,468   | `indexed` is not in `IN_FLIGHT`, so the plan is `wait`      |

It would recover **none** of them.

What the database does hold is `evidence_items.processingStatus`, which names
every unfinished item exactly. `scripts/requeue-pending.ts` walks that column and
re-enqueues the stage each item still needs:

```bash
# inside the worker container, which already has node_modules and the right env
docker exec cdfir-worker-1 sh -c 'cd /app && ./node_modules/.bin/tsx requeue-pending.ts'
docker exec cdfir-worker-1 sh -c 'cd /app && ./node_modules/.bin/tsx requeue-pending.ts --commit'
```

Dry run by default. Verified on staging 2026-09-15: 200 items enqueued, 199
reached `indexed` within a minute.

**It is a repair tool, not a safety net.** It re-reads every file from object
storage, so a full run costs the same CPU the original run would have, and it
cannot recover anything that never reached the database. Carrying the Redis
volume is still far cheaper than rebuilding from it.

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

Copy it yourself — this file is secrets end to end.

Once the new host can reach the old one over SSH (see section 3), the cleanest
route is host to host, so the file never lands on a laptop:

```bash
# NEW host
ssh ian@<OLD-IP> 'cat /var/www/AEGCloudDFIR/.env' > /tmp/env.new
grep -cE '^[A-Z_]+=' /tmp/env.new      # expect ~80. If it says 0, STOP.
install -m 600 /tmp/env.new /var/www/AEGCloudDFIR/.env && shred -u /tmp/env.new
```

**Count the keys. Do not just check the file exists.** On 2026-09-15 an
`scp <src> /dev/stdout | ssh ...` produced a **0-byte** `.env`; `[ -f .env ]`
said "present", every container started, and three of them baked in the wrong
password before anyone noticed.

**`CDFIR_IMAGE_TAG` is not in `.env.example`, and compose defaults it to `dev`.**
That tag does not exist in the registry, so a fresh host pulls nothing. Add it
explicitly, matching what production runs:

```bash
grep CDFIR_IMAGE_TAG /var/www/AEGCloudDFIR/.env    # on the OLD host
echo 'CDFIR_IMAGE_TAG=sha-xxxxxxx' >> .env         # on the NEW host, if absent
grep -c '^CDFIR_IMAGE_TAG=' .env                   # must be 1, not 2
```

Nine other variables are also missing from `.env.example` and silently become
`changeme-local-only`: `CDFIR_LOCAL_PG_SUPER_PASSWORD`,
`CDFIR_LOCAL_OS_ADMIN_PASSWORD`, `CDFIR_LOCAL_MINIO_PASSWORD`,
`CDFIR_LOCAL_AUTHENTIK_SECRET`, `CDFIR_LOCAL_AUTHENTIK_PG_PASSWORD`,
`CDFIR_LOCAL_AUTHENTIK_ADMIN_PASSWORD`, `CDFIR_AUTHENTIK_ADMIN_EMAIL`,
`CDFIR_GRAFANA_ADMIN_PASSWORD`, `NEXT_PUBLIC_API_URL`. Copying the whole old
`.env` gets them all; building one from the example does not.

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
disk rather than cores, say so and leave concurrency alone.

Measured on the 2026-09-15 move, both ends at the default concurrency of 4:

|                 | old (5 cores, 15 GB) | new (8 cores, 31 GB) |
| --------------- | -------------------- | -------------------- |
| extract drained | ~1,500/hour          | ~1,800/hour          |
| load average    | 27                   | 29                   |
| swap in use     | 1.8 GB               | 256 KiB              |

**Raising concurrency would not have helped.** `docker stats` on the new box
showed `tika` at 354% CPU and `worker` at 327% — about 7.7 of 8 cores already
busy at concurrency 4. Tika and Tesseract are multi-threaded, so the job count
is not the limit; the machine is. A 20% gain from 60% more cores is the honest
expectation.

What the move actually bought: disk 98 GB -> 630 GB (the old box sat at 82% and
had already taken Postgres down once) and RAM 15 GB -> 31 GB, which stopped the
swapping. If you need the backlog to drain faster, buy cores or do less work per
item. No setting in this file will do it.

Symlink so either compose invocation works:

```bash
ln -sf /var/www/AEGCloudDFIR/.env /var/www/AEGCloudDFIR/infra/compose/.env
```

## 3. Stop the old host and take everything

Downtime starts here. Budget an hour.

### Give the new host SSH to the old one first — it is 56x faster

Do not relay through your laptop. Measured on 2026-09-15:

| Route               | Speed      | 16 GB takes     |
| ------------------- | ---------- | --------------- |
| old -> Mac -> new   | 2.5 MB/s   | **109 minutes** |
| old -> new directly | 140.8 MB/s | **2 minutes**   |

The slow leg is the old host's upload to the laptop (2.3 MB/s). The two servers
talk to each other at 1.18 Gbit/s with 45 ms latency.

`root` on a fresh Linode has an `authorized_keys` file but no keypair of its
own. Make one and install the **public** half on the old host:

```bash
# from your Mac
ssh cdfir-linode "ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 -q -C migration; cat /root/.ssh/id_ed25519.pub" \
  | ssh cdfir-server 'cat >> ~/.ssh/authorized_keys'
ssh cdfir-linode 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ian@<OLD-IP> hostname'
```

Note the old host may not be able to reach the **new** one on port 22 even when
the reverse works, so pull from the new host rather than pushing from the old.

### Run every long step detached

SSH dropped mid-script twice during the 2026-09-15 move, once truncating a dump
at 21% and once killing a restore between the dump and the `docker stop`. Write
the step to a file, run it with `setsid nohup`, and record exit codes:

```bash
cat > /root/step.sh <<'EOF'
#!/usr/bin/env bash
exec > /root/step.log 2>&1
... ; echo "exit=$?"
EOF
chmod +x /root/step.sh
setsid nohup /root/step.sh >/dev/null 2>&1 </dev/null &
```

**Check the old host's free space first, and do not write the dumps onto it.**

```bash
df -h /tmp        # /tmp is on / here, not its own filesystem
```

On 2026-09-15 that read `18G` free at 82% used, against dumps totalling roughly
7-10 GB. It would probably have fit. "Probably" is not good enough on the box
where a full disk once crashed PostgreSQL and then stopped it restarting,
because replaying the log also needs space.

So stream everything straight to the new host, which has the room. Nothing is
written to the old disk at any point. Run these **on the NEW host**, pulling from
the old one — not from your laptop (see the 56x measurement above):

```bash
# NEW host. Flush the old Redis to disk, then stop the producers only.
ssh ian@<OLD-IP> 'cd /var/www/AEGCloudDFIR \
  && docker exec cdfir-redis-1 redis-cli SAVE \
  && docker compose -f infra/compose/docker-compose.yml --env-file .env stop api web worker'

# Dumps: read on the old host, land here.
ssh ian@<OLD-IP> 'docker exec cdfir-postgres-1 pg_dump -U postgres -Fc -d cdfir' > /tmp/cdfir.dump
echo "pg_dump exit=$?"
ssh ian@<OLD-IP> 'docker exec cdfir-authentik-postgres-1 pg_dump -U authentik -Fc -d authentik' > /tmp/authentik.dump
echo "pg_dump exit=$?"
ls -lh /tmp/*.dump
```

Expect roughly 10 minutes for the main dump. The limit is `pg_dump` compressing
on the old box's CPU (~2 MB/s measured while it was still serving traffic,
~10 MB/s once `api`/`web`/`worker` were stopped), not the network.

**Only `pg_dump` exiting 0 proves a dump is complete.** Nothing else does:

- `pg_restore --list` reported `OK, 533 entries, 51 TABLE DATA` on a dump that
  was **21% written and still growing**. It reads the header and never looks at
  the body.
- A file that has stopped growing is not necessarily finished — it may be a dead
  pipe. A 1.26 GB dump looked stable and complete; the real one was **1.8 GB**.
- Size is only useful once you know the true size, which you only know from a
  run that exited 0.

So: run it detached, write `echo $? > /tmp/dump.exit`, and refuse to go further
until that file says `0`.

`pg_dump` **must run as a superuser**. Every tenant table carries
`FORCE ROW LEVEL SECURITY`, which applies to the owner too — a dump taken as
`cdfir` or `cdfir_migrator` produces a table of contents that looks complete
over data that is empty. `pg_restore --list` cannot detect it.

Now the volumes, the same way. Note there is no `-v /tmp:/out` mount: the tar
goes to stdout, so nothing lands on the old disk.

**Land each tar as a file and check its size before you touch the target
volume.** Extracting straight from a stream means a dropped connection leaves a
half-written volume, and the extract has already deleted what was there.

```bash
# NEW host
for v in opensearch redis; do
  ssh ian@<OLD-IP> "docker run --rm -v cdfir_${v}-data:/src alpine tar c -C /src ." > "/tmp/${v}-vol.tar"
  echo "$v: exit=$? size=$(stat -c %s /tmp/${v}-vol.tar)"
done
# sanity-check the sizes, THEN stop the local services and swap the contents
docker compose -f infra/compose/docker-compose.yml --env-file .env stop api worker opensearch redis
for v in opensearch redis; do
  docker run --rm -i -v "cdfir_${v}-data:/dst" alpine \
    sh -c 'rm -rf /dst/* /dst/..?* 2>/dev/null; tar x -C /dst' < "/tmp/${v}-vol.tar"
done
docker compose -f infra/compose/docker-compose.yml --env-file .env --profile app up -d
```

Skip `gzip`: the network runs at 140 MB/s and Lucene segments barely compress,
so it only adds CPU. Measured sizes on 2026-09-15: opensearch 4.83 GB, redis
470 MB, both copied in well under a minute.

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

### Never pass `--no-owner` or `--no-privileges`

The `cdfir`, `cdfir_migrator` and `authentik` roles exist on **both** hosts with
the same names, so a plain `pg_restore` carries ownership and grants across.
Stripping them leaves a database that looks perfect and is unusable:

|                   | after `--no-owner --no-privileges` | correct          |
| ----------------- | ---------------------------------- | ---------------- |
| table owner       | `postgres`                         | `cdfir_migrator` |
| grants to `cdfir` | **0**                              | 204              |

Row counts matched exactly, every table was present, and the app role could not
read a single one. If it has already happened, repair it rather than re-running
a 1.8 GB restore:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename    FROM pg_tables    WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO cdfir_migrator', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO cdfir_migrator', r.sequencename);
  END LOOP;
  FOR r IN SELECT viewname     FROM pg_views     WHERE schemaname='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO cdfir_migrator', r.viewname);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO cdfir;
GRANT USAGE, SELECT               ON ALL SEQUENCES IN SCHEMA public TO cdfir;
ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cdfir;
ALTER DEFAULT PRIVILEGES FOR ROLE cdfir_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cdfir;
```

If the roles already carry the wrong password because they were created before
`.env` was in place, reset them without printing the value:

```bash
pw=$(grep '^CDFIR_DB_PASSWORD=' .env | head -1 | cut -d= -f2-)
docker exec -i -e PGPW="$pw" cdfir-postgres-1 sh -c \
  'psql -v ON_ERROR_STOP=1 -U postgres -v pw="$PGPW" -c "ALTER ROLE cdfir_migrator WITH PASSWORD :'"'"'pw'"'"'" \
                                          -c "ALTER ROLE cdfir WITH PASSWORD :'"'"'pw'"'"'"'
```

Restore the databases:

```bash
docker exec -i cdfir-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS cdfir"
docker exec -i cdfir-postgres-1 psql -U postgres -c "CREATE DATABASE cdfir OWNER cdfir"
docker exec -i cdfir-postgres-1 pg_restore -U postgres -d cdfir --no-owner < /tmp/cdfir.dump
docker exec -i cdfir-authentik-postgres-1 pg_restore -U authentik -d authentik --clean --no-owner \
  < /tmp/authentik.dump
```

### `api`, `worker` and `web` need `--profile app`

They carry `profiles: ['app']` in `docker-compose.yml`. A bare `up -d` starts the
eleven infrastructure containers and **none of the application**, with no error:

```bash
docker compose -f infra/compose/docker-compose.yml --env-file .env --profile app up -d
```

Apply any migrations the images expect. **This does not happen automatically**
— a missed migration has reached production as a bare 500 before. Note
`./node_modules/.bin/prisma`, not `pnpm`: the runtime images never run
`corepack enable`, so `pnpm` is not on PATH inside them.

```bash
docker exec cdfir-api-1 sh -c 'cd /app/packages/database && ./node_modules/.bin/prisma migrate deploy'
```

Expect `No pending migrations to apply.` when the dump is current — that is the
check that the schema matches the images, not a no-op to skip. The old
instruction below uses `run --rm api pnpm ...`, which fails on a bare host:

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

### OpenSearch: copy the volume and its user comes with it

The app user `cdfir_app` lives in the OpenSearch volume's security index, so a
copied volume already has it and the password already matches `.env`. Only
create it by hand (`opensearch-security.md` step 3) if you started from an empty
volume. Either way `/readyz` reports `search: unreachable (ResponseError)` until
that user exists, which reads like a network problem and is not one.

### Authentik carries the users, and needs no `--no-owner` either

A fresh Authentik gives you `akadmin` and none of your people. Move its database
the same way, with matching image versions on both sides:

```bash
ssh ian@<OLD-IP> 'docker exec cdfir-authentik-postgres-1 pg_dump -U authentik -Fc -d authentik' > /tmp/authentik.dump
docker stop cdfir-authentik-server-1 cdfir-authentik-worker-1
docker exec -i cdfir-authentik-postgres-1 psql -U authentik -d postgres -c "DROP DATABASE authentik"
docker exec -i cdfir-authentik-postgres-1 psql -U authentik -d postgres -c "CREATE DATABASE authentik OWNER authentik"
docker exec -i cdfir-authentik-postgres-1 pg_restore -U authentik -d authentik < /tmp/authentik.dump
docker start cdfir-authentik-server-1 cdfir-authentik-worker-1
```

Then check the OIDC secret in the restored database matches `.env`, or sign-in
fails with credentials that look right. The `cdfir` provider must match
`CDFIR_OIDC_CLIENT_SECRET`; `cdfir-staging` uses its own variable and is
**expected** to differ:

```sql
SELECT p.name, o.client_id, o.client_secret
  FROM authentik_providers_oauth2_oauth2provider o
  JOIN authentik_core_provider p ON p.id = o.provider_ptr_id;
```

The primary key is `provider_ptr_id`, not `id`.

### nginx: reload it, do not just test it

`nginx -t` only parses the file. Until `systemctl reload nginx`, the old config
is still serving — which on 2026-09-15 meant Ubuntu's default site answered
`200` for `/` and `404` for `/healthz`, and looked exactly like a broken
proxy_pass. Also remove `/etc/nginx/sites-enabled/default`.

### Certificates, in this order

`aegclouddfir-apex.conf` (apex, `www`, `admin`) has real `443` blocks that
`include /etc/letsencrypt/options-ssl-nginx.conf`. That file does not exist
until certbot has run once, so installing the apex config first makes
`nginx -t` fail with `open() ... options-ssl-nginx.conf failed`.

1. Install `aegclouddfir.conf` only. It is deliberately HTTP-only; certbot
   rewrites it.
2. `certbot --nginx -d app -d api -d auth ... --redirect`
3. Install `aegclouddfir-apex.conf` and reload — it loads now.
4. Expand the certificate to all six names. Use `certonly --webroot` so certbot
   does not rewrite the config you just installed:

```bash
certbot certonly --webroot -w /var/www/html --cert-name app.aegclouddfir.com --expand --non-interactive \
  -d app.aegclouddfir.com -d api.aegclouddfir.com -d auth.aegclouddfir.com \
  -d aegclouddfir.com -d www.aegclouddfir.com -d admin.aegclouddfir.com
systemctl reload nginx
```

**Step 2's `--redirect` breaks the ACME path for any name that has no server
block yet** — the request is 301'd to HTTPS, which fails because the certificate
does not cover it. That is why the apex config goes in before the expansion, not
after. Verify all six before running certbot:

```bash
echo probe-ok > /var/www/html/.well-known/acme-challenge/probe
for d in app api auth; do curl -sL "http://$d.aegclouddfir.com/.well-known/acme-challenge/probe"; done
for d in aegclouddfir.com www.aegclouddfir.com admin.aegclouddfir.com; do curl -sL "http://$d/.well-known/acme-challenge/probe"; done
```

Then prove renewal rather than assuming it: `certbot renew --dry-run` must say
`all simulated renewals succeeded`, and `systemctl is-enabled certbot.timer`
must say `enabled`.

### Firewall

Allow 22 **before** enabling, and arm a rollback so a mistake is not permanent:

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw default deny incoming && ufw default allow outgoing
ufw --force enable
```

Then confirm with a **fresh** connection — an existing multiplexed SSH session
survives regardless and proves nothing:

```bash
ssh -o ControlMaster=no -o ControlPath=none <host> 'echo ok'
```

**ufw does not filter Docker-published ports.** Docker writes its own iptables
rules that bypass ufw's INPUT chain, and `ufw status` will still say `active`.
What actually protects the datastores is the `127.0.0.1:` prefix on every port
mapping in `docker-compose.yml`. Keep it. Check with:

```bash
docker ps --format '{{.Names}}|{{.Ports}}' | grep -E '0\.0\.0\.0|:::'   # expect no output
```

### The rest

1. Lower the DNS TTL to 300s **the day before**, so a rollback is minutes.
2. Point the A records at the new IP. Verify where traffic actually lands, not
   just what DNS says: `curl -o /dev/null -w '%{remote_ip}\n' https://app...`.
3. Re-add cron: `scripts/backup-postgres.sh` at 03:15 UTC and the
   `packages/monitoring` check every 5 minutes. The monitor treats silence as an
   alert, so a forgotten cron reads as an outage — which is the correct
   behaviour, but confusing if you have forgotten why.
4. Update the healthchecks.io ping URL if the check is host-specific.

## 7. Staging, once production is on the new host

Staging cannot move on its own. Its compose file joins production's network as
**external**:

```yaml
networks:
  default:
    name: cdfir_default
    external: true
```

It defines six containers and reaches five more by container name — MinIO,
ClamAV, Tika, Authentik and nginx. So staging follows production to the new
host; it cannot lead. Done in the wrong order you end up standing the whole
production stack up twice.

### Give staging its own certificate

Do **not** add `staging` and `api-staging` to production's certificate. One
lineage covering both means a staging DNS mistake fails the renewal for
production too. Separate lineages cost nothing:

```bash
certbot certonly --webroot -w /var/www/html --cert-name staging.aegclouddfir.com \
  --non-interactive -d staging.aegclouddfir.com -d api-staging.aegclouddfir.com
certbot install --nginx --cert-name staging.aegclouddfir.com --redirect --non-interactive
```

`certbot install` deploys a certificate that already exists into nginx without
re-issuing it — that is what adds the `443` blocks to the HTTP-only config.

**Install `aegclouddfir-staging.conf` before asking for the certificate.** Its
`:80` blocks are what serve the ACME challenge. Without them the request is
301'd to HTTPS by production's `--redirect`, and HTTPS has no certificate for
those names yet. Same ordering trap as the apex config.

### `.env.staging` goes in before anything starts

The same first-start password trap applies: staging has its **own** Postgres,
Redis and OpenSearch. Copy `.env.staging` (35 keys) into place, then start
containers. It already carries its own `CDFIR_IMAGE_TAG`, so nothing to edit.

Two values must line up or you get failures that look like something else:

- `CDFIR_WEB_HOST_PORT` / `CDFIR_API_HOST_PORT` must match the `proxy_pass`
  ports in `aegclouddfir-staging.conf` (3100 and 4100), or nginx 502s.
- `CDFIR_OIDC_CLIENT_SECRET` must equal the `cdfir-staging` provider's secret in
  **production's** Authentik database, or sign-in fails with credentials that
  look correct. Compare before starting:

```sql
SELECT o.client_secret FROM authentik_providers_oauth2_oauth2provider o
  JOIN authentik_core_provider p ON p.id = o.provider_ptr_id
 WHERE o.client_id = 'cdfir-staging';
```

### Carry the three volumes

`cdfir-staging_staging-{postgres,redis,opensearch}-data`. Copying them brings
staging's OpenSearch user and security config with it, so there is nothing to
create by hand. Measured 2026-09-15: 2.10 GB, 193 MB and 1.07 GB, copied in
90 seconds. The old staging containers were already stopped, so nothing needed
flushing first.

Start with the invocation `scripts/deploy-staging.sh` uses:

```bash
docker compose -p cdfir-staging --env-file .env.staging \
  -f infra/compose/docker-compose.staging.yml up -d --remove-orphans \
  postgres-staging redis-staging opensearch-staging api-staging worker-staging web-staging
```

Then check `/readyz` inside `cdfir-staging-api` and confirm isolation held: a
separate database port (55433), the `cdfir-staging` index prefix, and its own
six containers.

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
