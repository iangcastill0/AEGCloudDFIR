# Turning on OpenSearch authentication

## Why

With `plugins.security.disabled: true`, OpenSearch accepts every request with no
credentials. On this deployment that meant a plain `curl` from the server read all
2,347 indexed evidence documents — and that server is shared with an unrelated
application. This closes that.

Authentication is now the default in `infra/compose/docker-compose.yml`. What
follows is the one-time work to switch a **running** deployment over.

## What this does and does not do

- **Does**: requires a username and password for every OpenSearch request, and
  gives the app a user that can only touch `cdfir-*` indices.
- **Does not**: encrypt REST traffic. Clients reach OpenSearch only over the
  compose network, and the search adapter has no way to trust a private CA, so a
  self-signed certificate would just be disabled again at the client. Node-to-node
  transport is TLS regardless — the security plugin requires it. Revisit if
  OpenSearch is ever reachable from outside the host.

## Before you start

Search can be rebuilt from PostgreSQL at any time (`pnpm tsx scripts/reindex.ts`),
so the index is not the only copy of anything. The risk is a wrong password
leaving search returning 401 while the rest of the app looks fine — so verify at
the end rather than assuming.

## Steps

All on the **server** unless marked otherwise.

### 1. Choose the app password and put it in `.env`

`CDFIR_OPENSEARCH_USERNAME` and `CDFIR_OPENSEARCH_PASSWORD` are read by both the
api and the worker. Write the values bare — no quotes — because compose passes
surrounding quotes into the value.

```bash
cd /var/www/AEGCloudDFIR
cp -p .env ~/env-backup-before-opensearch
nano .env
```

Set:

```
CDFIR_OPENSEARCH_USERNAME=cdfir_app
CDFIR_OPENSEARCH_PASSWORD=<a long random password you choose>
```

Leave `CDFIR_LOCAL_OS_ADMIN_PASSWORD` as it is — that is the admin account, and it
is what creates the app user in step 3.

### 2. Restart OpenSearch with security on

```bash
cd /var/www/AEGCloudDFIR/infra/compose
docker compose --env-file ../../.env up -d --force-recreate opensearch
```

Wait for it to come up, then confirm anonymous access is now refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:59200/_cluster/health
```

**401 is success.** The old answer was 200.

### 3. Create the app's user and role

Uses the admin account to create a user limited to `cdfir-*`.

```bash
cd /var/www/AEGCloudDFIR
ADMIN_PW=$(grep -E '^CDFIR_LOCAL_OS_ADMIN_PASSWORD=' .env | cut -d= -f2-)
APP_PW=$(grep -E '^CDFIR_OPENSEARCH_PASSWORD=' .env | cut -d= -f2-)

curl -s -u "admin:$ADMIN_PW" -X PUT \
  "http://127.0.0.1:59200/_plugins/_security/api/roles/cdfir_app" \
  -H 'Content-Type: application/json' -d '{
    "cluster_permissions": ["cluster_composite_ops", "cluster:monitor/health"],
    "index_permissions": [
      { "index_patterns": ["cdfir-*"], "allowed_actions": ["indices_all"] }
    ]
  }'

curl -s -u "admin:$ADMIN_PW" -X PUT \
  "http://127.0.0.1:59200/_plugins/_security/api/internalusers/cdfir_app" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$APP_PW\",\"opendistro_security_roles\":[\"cdfir_app\"]}"
```

Both should answer `{"status":"CREATED", ...}`.

### 4. Restart the app so it picks up the credentials

```bash
cd /var/www/AEGCloudDFIR/infra/compose
docker compose --env-file ../../.env up -d --force-recreate api worker
```

### 5. Verify — do not skip this

```bash
# the app user can search; expects a document count
curl -s -u "cdfir_app:$APP_PW" "http://127.0.0.1:59200/cdfir-evidence/_count"

# anonymous is refused
curl -s -o /dev/null -w 'anonymous: %{http_code}\n' http://127.0.0.1:59200/cdfir-evidence/_count

# the app user cannot reach anything outside cdfir-*  (403 expected)
curl -s -o /dev/null -w 'other indices: %{http_code}\n' \
  -u "cdfir_app:$APP_PW" "http://127.0.0.1:59200/_cat/indices"
```

Then search for something in the web app. Search returning results is the only
proof that matters; the api's `/readyz` does **not** probe OpenSearch, so it will
report `ok` even if every search is failing.

## If search breaks

Symptom: the app loads, but searches error or return nothing.

```bash
docker logs cdfir-api-1 --tail 50 | grep -i -E 'opensearch|401|security'
```

A 401 means the password in `.env` and the one in OpenSearch differ. Re-run step 3
to set the user's password again, then step 4.

To back out entirely, add `CDFIR_OPENSEARCH_SECURITY_DISABLED=true` to `.env` and
recreate the opensearch container. That reopens the hole, so treat it as a
temporary measure while fixing credentials.
