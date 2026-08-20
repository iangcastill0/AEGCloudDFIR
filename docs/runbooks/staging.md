# Staging

A second copy of the app on the same server, at
<https://staging.aegclouddfir.com>. It updates itself whenever tests pass on
`main`. Production never does — you approve every live deploy.

```
push to main → CI (~4 min) → images built (~2 min) → STAGING updates itself
                                                   → production waits for you
```

## What is separate, and what is shared

**Separate, so staging can never touch real evidence:**

| Thing             | Staging                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| Database          | its own container and volume (`cdfir-staging_staging-postgres-data`)             |
| Redis / job queue | its own container, so no worker crosses over                                     |
| Evidence files    | MinIO on this host, buckets `cdfir-staging-*` — **no Wasabi credentials at all** |
| Search index      | prefix `cdfir-staging`, and its own OpenSearch user limited to `cdfir-staging-*` |
| Sign-in           | its own Authentik application (`cdfir-staging`)                                  |
| Secrets           | its own `.env.staging`; every value differs from production                      |

**Shared, because these hold no data of their own and are the memory-hungry
parts:** OpenSearch (namespaced by prefix), ClamAV, Tika. Running second copies
would cost roughly 2.5 GB of RAM and buy no isolation.

Staging runs **the same api and worker images as production** — only the
configuration differs, so what you exercise is what ships. The web image is the
one exception: Next bakes `NEXT_PUBLIC_*` in at build time, so CI publishes a
second web image tagged `…-staging`.

## One-time setup

### 1. DNS

Add two A records pointing at `38.248.7.156`:

- `staging.aegclouddfir.com`
- `api-staging.aegclouddfir.com`

Two hosts, not one, because the session cookie uses the `__Host-` prefix: it is
tied to exactly one hostname, so the API needs its own.

### 2. nginx and certificates

```bash
sudo cp /var/www/AEGCloudDFIR/infra/nginx/aegclouddfir-staging.conf \
        /etc/nginx/sites-available/aegclouddfir-staging
sudo ln -sf /etc/nginx/sites-available/aegclouddfir-staging \
            /etc/nginx/sites-enabled/aegclouddfir-staging
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d staging.aegclouddfir.com -d api-staging.aegclouddfir.com
```

### 3. `.env.staging`

```bash
cd /var/www/AEGCloudDFIR
cp .env.staging.example .env.staging
chmod 600 .env.staging
nano .env.staging
```

Fill in every blank. Generate them with:

```bash
openssl rand -hex 32                    # CDFIR_SESSION_SECRET
openssl rand -base64 32                 # CDFIR_KEK_LOCAL_MASTER_KEY
openssl rand -base64 24 | tr -d '/+='   # the passwords
```

Write values **bare, with no quotes** — compose passes surrounding quotes into
the value, which is how the Grafana password once became a string containing
quote characters.

Two values must match something else, or sign-in and search fail with credentials
that look correct:

- `CDFIR_OIDC_CLIENT_SECRET` must equal `CDFIR_STAGING_OIDC_CLIENT_SECRET` in
  **production's** `.env` (Authentik reads it from there to build the provider).
- `CDFIR_S3_SECRET_ACCESS_KEY` must be MinIO's root password, i.e.
  `CDFIR_LOCAL_MINIO_PASSWORD` from production's `.env`.

### 4. Register staging's sign-in application

Add the client secret to production's `.env` and restart Authentik so it applies
the new blueprint:

```bash
cd /var/www/AEGCloudDFIR
# append CDFIR_STAGING_OIDC_CLIENT_SECRET=<same value as .env.staging> to .env
cd infra/compose
docker compose --env-file ../../.env up -d authentik-server authentik-worker
docker compose --env-file ../../.env logs --tail 30 authentik-worker | grep -i blueprint
```

The staging blueprint is a **separate file**, so a mistake in it cannot reject
the production provider.

### 5. Staging's own search user and buckets

```bash
cd /var/www/AEGCloudDFIR
ADMIN_PW=$(grep -E '^CDFIR_LOCAL_OS_ADMIN_PASSWORD=' .env | cut -d= -f2-)
STG_PW=$(grep -E '^CDFIR_OPENSEARCH_PASSWORD=' .env.staging | cut -d= -f2-)

curl -s -u "admin:$ADMIN_PW" -X PUT \
  "http://127.0.0.1:59200/_plugins/_security/api/roles/cdfir_staging" \
  -H 'Content-Type: application/json' -d '{
    "cluster_permissions": ["cluster_composite_ops", "cluster:monitor/health"],
    "index_permissions": [
      { "index_patterns": ["cdfir-staging-*"], "allowed_actions": ["indices_all"] }
    ]
  }'

curl -s -u "admin:$ADMIN_PW" -X PUT \
  "http://127.0.0.1:59200/_plugins/_security/api/internalusers/cdfir_staging" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$STG_PW\",\"opendistro_security_roles\":[\"cdfir_staging\"]}"
```

MinIO buckets:

```bash
docker exec cdfir-minio-1 sh -c \
  'mc alias set local http://localhost:9000 minioadmin "$MINIO_ROOT_PASSWORD" >/dev/null &&
   mc mb --ignore-existing local/cdfir-staging-evidence &&
   mc mb --ignore-existing local/cdfir-staging-quarantine'
```

### 6. First start

```bash
cd /var/www/AEGCloudDFIR && ./scripts/deploy-staging.sh main
```

Migrations run when staging's worker boots, against staging's own empty
database.

## Day to day

Nothing. Push to `main`, and staging has it a few minutes later — watch **Deploy
staging** in the Actions tab. To put an older build on staging, run that workflow
by hand with a different `ref`.

Promoting to production is unchanged: Actions → **Deploy** → approve.

## Things worth knowing

- **Staging holds no real evidence and no Wasabi credentials.** Treat anything you
  upload there as disposable; the nightly backup covers production only.
- **Staging is not monitored.** The 5-minute health check watches production. A
  broken staging will not page you, by design.
- **Production's OpenSearch user can read staging's indices** (its pattern is
  `cdfir-*`, which also matches `cdfir-staging-*`). The reverse is not true.
  Harmless today; worth tightening if staging ever holds anything sensitive.
- **Staging shares ClamAV and Tika with production.** A huge staging import
  competes for them, so do not load-test on a working day.
