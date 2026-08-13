# Connecting AEG-CloudDFIR to a domain

This guide takes the stack from `localhost` to real hostnames with HTTPS.
Examples use `example.com` — substitute your own domain everywhere.

## 0. What gets exposed, and what must not

The stack has **three** browser-facing services and several that must stay
private:

| Service                              | Port                      | Hostname           | Public? |
| ------------------------------------ | ------------------------- | ------------------ | ------- |
| Web UI (Next.js)                     | 3000                      | `app.example.com`  | **yes** |
| API (NestJS/Fastify)                 | 4000                      | `api.example.com`  | **yes** |
| Authentik (identity provider)        | 9443→9000                 | `auth.example.com` | **yes** |
| Worker                               | 5100 health, 9464 metrics | —                  | **no**  |
| PostgreSQL, Redis, OpenSearch, MinIO | 5432/6379/9200/9000       | —                  | **no**  |

The worker has no user-facing surface: exposing it publishes health and
Prometheus metrics for no benefit. The datastores hold evidence and secrets —
in the shipped compose file they bind to `127.0.0.1` only. Keep it that way and
let the reverse proxy be the sole ingress.

> **Constraint that will bite you if ignored:** the web app and the API must
> share the same registrable domain (`app.example.com` + `api.example.com`, not
> `app.example.com` + `api.someotherdomain.net`). The login session cookie is
> `SameSite=Lax`, which browsers send on cross-_origin_ requests only when they
> are same-_site_. Split the registrable domain and every authenticated API call
> silently loses its cookie — you get an endless redirect to sign-in.

## 1. DNS

Create three A records (or AAAA for IPv6) pointing at the server's public IP:

```
app.example.com.    A    203.0.113.10
api.example.com.    A    203.0.113.10
auth.example.com.   A    203.0.113.10
```

Verify before touching TLS — certificate issuance fails on unresolved names:

```bash
dig +short app.example.com api.example.com auth.example.com
```

## 2. Environment configuration

On the server, in your deployment directory, edit `.env` (created from
`.env.example`). These are the values that must change from local defaults:

```bash
NODE_ENV=production                 # enables __Host- cookie prefix + Secure; refuses demo mode
CDFIR_TRUST_PROXY=true              # honour X-Forwarded-* from the reverse proxy

CDFIR_API_PUBLIC_URL=https://api.example.com
CDFIR_WEB_PUBLIC_URL=https://app.example.com
CDFIR_CORS_ALLOWED_ORIGINS=https://app.example.com

CDFIR_OIDC_ISSUER=https://auth.example.com/application/o/cdfir/
CDFIR_OIDC_CLIENT_ID=cdfir
CDFIR_OIDC_CLIENT_SECRET=<from Authentik>

# Browser bundle values — see the warning in step 3
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_AUTHENTIK_URL=https://auth.example.com
```

Generate real secrets (never reuse the placeholders):

```bash
openssl rand -hex 32      # CDFIR_SESSION_SECRET
openssl rand -base64 32   # CDFIR_KEK_LOCAL_MASTER_KEY  (losing this orphans stored connector tokens)
```

`NODE_ENV=production` is not cosmetic: it switches the session cookie to the
`__Host-` prefix with `Secure`, which **only works over HTTPS**. Setting it
before TLS is working will leave you unable to log in.

## 3. Build the web image with the right API URL

Next.js **inlines `NEXT_PUBLIC_*` into the browser bundle at build time**.
Setting them at runtime does nothing for client-side code — the bundle will keep
calling `http://localhost:4000`.

The compose file passes them as build args, so they must be in the environment
_when you build_:

```bash
cd /var/www/AEGCloudDFIR
set -a; source .env; set +a          # export the values for the build
docker compose -f infra/compose/docker-compose.yml build web
```

**Any time you change `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_AUTHENTIK_URL`, you
must rebuild the web image — restarting is not enough.**

## 4. Reverse proxy with TLS

Two options. Caddy is fewer moving parts (automatic certificates); nginx is more
common. Pick one.

### Option A — Caddy (recommended)

`/etc/caddy/Caddyfile`:

```
app.example.com {
    reverse_proxy 127.0.0.1:3000
}

api.example.com {
    reverse_proxy 127.0.0.1:4000
    request_body {
        max_size 11GB        # PST/OST uploads; keep >= CDFIR_UPLOAD_MAX_BYTES
    }
}

auth.example.com {
    reverse_proxy 127.0.0.1:9443
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews Let's Encrypt certificates automatically.

### Option B — nginx + certbot

`/etc/nginx/sites-available/cdfir.conf`:

```nginx
# Shared proxy headers — CDFIR_TRUST_PROXY=true makes the API honour these.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

server {
    listen 80;
    server_name app.example.com api.example.com auth.example.com;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name app.example.com;
    location / { proxy_pass http://127.0.0.1:3000; }
}

server {
    listen 443 ssl http2;
    server_name api.example.com;
    # PST/OST uploads are large and streamed; do not buffer them to disk.
    client_max_body_size 11G;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    location / { proxy_pass http://127.0.0.1:4000; }
}

server {
    listen 443 ssl http2;
    server_name auth.example.com;
    location / { proxy_pass http://127.0.0.1:9443; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cdfir.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo certbot --nginx -d app.example.com -d api.example.com -d auth.example.com
sudo systemctl reload nginx
```

`client_max_body_size` matters: nginx's 1 MB default rejects every PST upload
with a 413. `proxy_request_buffering off` keeps large uploads streaming rather
than spooling to disk.

## 5. Update the OIDC redirect URI in Authentik

Authentik validates redirect URIs strictly, so it must know the new API host.
In the Authentik admin console (`https://auth.example.com/if/admin/`):

**Providers → cdfir → Redirect URIs**, set to exactly:

```
https://api.example.com/auth/callback
```

Confirm the issuer matches `CDFIR_OIDC_ISSUER` character for character —
including the trailing slash:

```bash
curl -s https://auth.example.com/application/o/cdfir/.well-known/openid-configuration | jq .issuer
```

A mismatch here produces `identity provider unavailable` (503) at
`/auth/login`. Note also that user identity keys on `(issuer, sub)`: **changing
the issuer URL later orphans existing accounts**, so settle the hostname before
onboarding real users.

## 6. Update provider OAuth redirect URIs

The Microsoft and Google connectors send users back to the API, so the
redirect URIs registered with each provider must be updated too — they are
allowlisted exactly.

**Microsoft (Entra → App registrations → your app → Authentication):**

```
https://api.example.com/api/v1/connectors/callback/microsoft
```

**Google (Cloud Console → Credentials → OAuth client → Authorized redirect URIs):**

```
https://api.example.com/api/v1/connectors/callback/google
```

See `docs/guides/microsoft-setup.md` and `docs/guides/google-setup.md` for the
full permission set.

## 7. Allow the web origin in object storage CORS

Previews and native downloads are fetched by the **browser** from presigned
URLs, so the evidence bucket must allow your web origin or those requests fail
CORS. On Wasabi (see `docs/guides/wasabi-setup.md`):

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "MaxAgeSeconds": 300
  }
]
```

## 8. Start and verify

```bash
cd /var/www/AEGCloudDFIR
docker compose -f infra/compose/docker-compose.yml up -d                      # datastores
pnpm --filter @aeg-clouddfir/database run migrate:deploy                       # schema
docker compose -f infra/compose/docker-compose.yml --profile app up -d         # api, worker, web
```

Verification ladder — each step depends on the one above it:

```bash
# 1. TLS terminates and certificates are valid
curl -sSI https://app.example.com | head -1
curl -sSI https://api.example.com/healthz | head -1

# 2. API is healthy end to end (database reachable)
curl -s https://api.example.com/readyz          # {"status":"ok","checks":{"database":"ok"}}

# 3. OIDC discovery resolves and matches
curl -s https://auth.example.com/application/o/cdfir/.well-known/openid-configuration | jq .issuer

# 4. Login redirects to Authentik (302 to auth.example.com, not localhost)
curl -sI "https://api.example.com/auth/login?redirectTo=/" | grep -i location

# 5. The BROWSER bundle points at the right API (catches a stale web image)
curl -s https://app.example.com/collections/new | grep -o 'api\.example\.com' | head -1
```

Then log in through the UI and confirm `/api/v1/me` returns your identity.

## Troubleshooting

| Symptom                                             | Cause                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Login loops back to sign-in forever                 | Web and API on different registrable domains, or `CDFIR_CORS_ALLOWED_ORIGINS` doesn't exactly match the web origin (scheme included) |
| `identity provider unavailable` (503)               | `CDFIR_OIDC_ISSUER` mismatch (trailing slash), or Authentik unreachable from the API container                                       |
| Browser calls `localhost:4000`                      | Web image built without `NEXT_PUBLIC_API_URL` — rebuild it (step 3)                                                                  |
| Cannot log in at all, cookie never set              | `NODE_ENV=production` without working HTTPS: `__Host-`/`Secure` cookies are dropped on plain HTTP                                    |
| PST upload fails with 413                           | Proxy body limit below `CDFIR_UPLOAD_MAX_BYTES`                                                                                      |
| Previews/downloads blank, CORS errors in console    | Bucket CORS missing the web origin (step 7)                                                                                          |
| `redirect_uri_mismatch` connecting Microsoft/Google | Provider redirect URI not updated to the new API host (step 6)                                                                       |

## Security checklist before real matters

- [ ] Only 80/443 open to the internet; datastores bound to `127.0.0.1` or a private network
- [ ] Every placeholder password from `.env.example` replaced
- [ ] `CDFIR_KEK_LOCAL_MASTER_KEY` and `CDFIR_SESSION_SECRET` generated, backed up in a secret manager
- [ ] `CDFIR_DEMO_MODE=false` (config refuses demo mode when `NODE_ENV=production`, but verify)
- [ ] MFA enforced in the Authentik flow — the app deliberately has no second factor of its own
- [ ] OpenSearch security plugin enabled with TLS (the compose file disables it for local dev only)
- [ ] Evidence bucket versioning + Object Lock configured if you need WORM (the app reports the real state and never claims WORM otherwise)
- [ ] Backups covering PostgreSQL and the object store, restore tested (`docs/runbooks/backup-restore.md`)
