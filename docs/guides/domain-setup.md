# Connecting AEG-CloudDFIR to a domain

This guide takes the stack from `localhost` to real hostnames with HTTPS,
written for the live deployment: domain **aegclouddfir.com** (DNS at Porkbun)
on the server **38.248.7.156**. Substitute if either changes.

## 0. Prerequisites on this server (verified state)

`38.248.7.156` is Ubuntu 24.04.3 LTS, 5 vCPU, 15 GB RAM (14 GB available) —
comfortable for this stack. Two gaps to close first:

**Docker is not installed.** The whole stack ships as containers, so nothing can
start until it is:

```bash
# Docker Engine + Compose plugin (official repo)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ian        # then log out and back in for it to apply
docker compose version             # verify the v2 plugin is present
```

Note that membership in the `docker` group is effectively root-equivalent —
acceptable on a dedicated app server, worth knowing.

**nginx is already serving another site.** `eclouddiscovery.net` is live on
ports 80/443 from this same box. Step 4 adds AEG-CloudDFIR alongside it rather
than replacing it — do not install a second reverse proxy.

## 0. What gets exposed, and what must not

The stack has **three** browser-facing services and several that must stay
private:

| Service                              | Port                      | Hostname                | Public? |
| ------------------------------------ | ------------------------- | ----------------------- | ------- |
| Web UI (Next.js)                     | 3000                      | `app.aegclouddfir.com`  | **yes** |
| API (NestJS/Fastify)                 | 4000                      | `api.aegclouddfir.com`  | **yes** |
| Authentik (identity provider)        | 9443→9000                 | `auth.aegclouddfir.com` | **yes** |
| Worker                               | 5100 health, 9464 metrics | —                       | **no**  |
| PostgreSQL, Redis, OpenSearch, MinIO | 5432/6379/9200/9000       | —                       | **no**  |

The worker has no user-facing surface: exposing it publishes health and
Prometheus metrics for no benefit. The datastores hold evidence and secrets —
in the shipped compose file they bind to `127.0.0.1` only. Keep it that way and
let the reverse proxy be the sole ingress.

> **Constraint that will bite you if ignored:** the web app and the API must
> share the same registrable domain (`app.aegclouddfir.com` + `api.aegclouddfir.com`, not
> `app.aegclouddfir.com` + `api.someotherdomain.net`). The login session cookie is
> `SameSite=Lax`, which browsers send on cross-_origin_ requests only when they
> are same-_site_. Split the registrable domain and every authenticated API call
> silently loses its cookie — you get an endless redirect to sign-in.

## 1. DNS (Porkbun)

**Current state (verified):** the apex resolves to Porkbun's parking IPs
(`207.207.210.36`, `207.207.210.50`) and a wildcard record sends _every_
subdomain — including `app`, `api`, and `auth` — to `uixie.porkbun.com`
(Porkbun's parking host). Until that changes, certificate issuance will fail or
issue for the wrong host, so do this step first.

In the Porkbun dashboard: **Domain Management → aegclouddfir.com → DNS**.

**Delete or edit the wildcard.** Porkbun's default parking includes a `*`
(wildcard) `ALIAS`/`CNAME` to `uixie.porkbun.com`. Explicit records win over a
wildcard, so the three records below are enough — but deleting the wildcard is
cleaner, because otherwise any typo'd hostname silently resolves to a parking
page instead of failing loudly.

**Add these A records** (Type `A`, TTL 600) — all answer `38.248.7.156`:

| Host    | Serves                                                      |
| ------- | ----------------------------------------------------------- |
| `app`   | the review application (Next.js)                            |
| `api`   | the API, including the OIDC login/callback endpoints        |
| `auth`  | Authentik — the OIDC issuer; this hostname is baked into    |
|         | `CDFIR_OIDC_ISSUER` and cannot be renamed without reissuing |
| `admin` | memorable alias that redirects to Authentik's admin console |
| `@`     | the apex — the sign-in front door (see below)               |
| `www`   | same as the apex                                            |

**Apex and `www` are the front door.** They 301 into
`https://api.aegclouddfir.com/auth/login`, which starts the OIDC flow at
Authentik; the callback drops the authenticated user on
`https://app.aegclouddfir.com`. So `aegclouddfir.com` means "sign me in", while
`app.aegclouddfir.com` remains the real application origin and is what you
bookmark or deep-link to. Visiting the app while signed out lands in the same
flow (the client redirects on a 401 from `/api/v1/me`) and returns you to the
path you asked for, so nothing is lost by entering either way.

**`admin` is a redirect, not a second Authentik origin.** It sends you to
`https://auth.aegclouddfir.com/if/admin/`. Authentik's session cookies are
scoped to the host that set them, so serving one Authentik instance under two
hostnames would split sessions and strand you mid-login. The redirect gives a
memorable URL while Authentik keeps enforcing its own admin authentication —
there is no extra nginx-level password, and adding one would only break the
OAuth flows that share this host. Restrict who can reach the admin interface
inside Authentik (admin group membership plus an MFA stage on the
`default-authentication-flow`), not in nginx.

**Verify propagation before continuing** (Porkbun is usually quick, but TTLs on
the old parking records can delay it):

```bash
dig +short app.aegclouddfir.com api.aegclouddfir.com auth.aegclouddfir.com \
            admin.aegclouddfir.com aegclouddfir.com www.aegclouddfir.com
# every answer must be exactly 38.248.7.156
# — NOT 207.207.210.x and NOT uixie.porkbun.com
```

If you still see the parking host, wait for the old TTL to expire and re-check;
do not proceed to TLS until every name answers with the server IP. Certbot
validates over HTTP-01, so a name that still points at parking makes issuance
fail for the whole request.

## 2. Environment configuration

On the server, in your deployment directory, edit `.env` (created from
`.env.example`). These are the values that must change from local defaults:

```bash
NODE_ENV=production                 # enables __Host- cookie prefix + Secure; refuses demo mode
CDFIR_TRUST_PROXY=true              # honour X-Forwarded-* from the reverse proxy

CDFIR_API_PUBLIC_URL=https://api.aegclouddfir.com
CDFIR_WEB_PUBLIC_URL=https://app.aegclouddfir.com
CDFIR_CORS_ALLOWED_ORIGINS=https://app.aegclouddfir.com

CDFIR_OIDC_ISSUER=https://auth.aegclouddfir.com/application/o/cdfir/
CDFIR_OIDC_CLIENT_ID=cdfir
CDFIR_OIDC_CLIENT_SECRET=<from Authentik>

# Browser bundle values — see the warning in step 3
NEXT_PUBLIC_API_URL=https://api.aegclouddfir.com
NEXT_PUBLIC_AUTHENTIK_URL=https://auth.aegclouddfir.com
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

## 4. Reverse proxy with TLS (nginx — already installed)

**Do not install Caddy on this server.** nginx 1.24.0 is already running and
owns ports 80/443, serving `eclouddiscovery.net` from
`/etc/nginx/sites-enabled/eclouddiscovery`. A second proxy cannot bind those
ports. Add AEG-CloudDFIR as an additional site instead — the existing one keeps
working untouched.

Create `/etc/nginx/sites-available/aegclouddfir`:

```nginx
# --- AEG-CloudDFIR: web UI, API, and Authentik -------------------------------
# Added alongside the existing eclouddiscovery.net site; nothing shared.

server {
    listen 80;
    listen [::]:80;
    server_name app.aegclouddfir.com api.aegclouddfir.com auth.aegclouddfir.com;
    # certbot writes its ACME challenge here; everything else goes to HTTPS.
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

# Web UI
server {
    listen 443 ssl http2;   # nginx 1.24 syntax; 1.25.1+ uses a separate `http2 on;`
    server_name app.aegclouddfir.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}

# API — CDFIR_TRUST_PROXY=true makes it honour the X-Forwarded-* headers below
server {
    listen 443 ssl http2;   # nginx 1.24 syntax; 1.25.1+ uses a separate `http2 on;`
    server_name api.aegclouddfir.com;

    # PST/OST uploads: nginx defaults to 1 MB and would 413 every upload.
    # Keep >= CDFIR_UPLOAD_MAX_BYTES (default 10 GiB) and stream rather than
    # spool to disk, since the API hashes the body as it arrives.
    client_max_body_size 11G;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Authentik (identity provider)
server {
    listen 443 ssl http2;   # nginx 1.24 syntax; 1.25.1+ uses a separate `http2 on;`
    server_name auth.aegclouddfir.com;

    location / {
        proxy_pass http://127.0.0.1:9443;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

Enable it and obtain certificates. Run these on the server (each needs sudo):

```bash
sudo cp infra/nginx/aegclouddfir.conf      /etc/nginx/sites-available/aegclouddfir
sudo cp infra/nginx/aegclouddfir-apex.conf /etc/nginx/sites-available/aegclouddfir-apex
sudo ln -sf /etc/nginx/sites-available/aegclouddfir      /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/aegclouddfir-apex /etc/nginx/sites-enabled/
sudo nginx -t                       # must pass before reloading
sudo systemctl reload nginx

sudo certbot --nginx --expand \
  -d app.aegclouddfir.com \
  -d api.aegclouddfir.com \
  -d auth.aegclouddfir.com \
  -d admin.aegclouddfir.com \
  -d aegclouddfir.com \
  -d www.aegclouddfir.com
```

certbot inserts the `ssl_certificate` lines and a renewal timer. It needs the
DNS from step 1 already pointing here, and port 80 reachable from the internet.
`--expand` is what lets you add names to the existing certificate instead of
being told one already covers a subset; all six names end up on one certificate
under `/etc/letsencrypt/live/app.aegclouddfir.com/`.

> **Do not re-copy `aegclouddfir.conf` after certbot has run.** certbot edits
> the _installed_ file in place to add the certificate paths, so overwriting it
> with the repo template silently removes TLS. The repo copy is the pre-certbot
> starting point only. `aegclouddfir-apex.conf` carries its own hand-written 443
> blocks pointing at the same certificate, so it is safe to re-copy — but verify
> with `diff` first in case certbot touched it:
>
> ```bash
> diff -u /etc/nginx/sites-available/aegclouddfir-apex \
>         infra/nginx/aegclouddfir-apex.conf
> ```

## 5. Update the OIDC redirect URI in Authentik

Authentik validates redirect URIs strictly, so it must know the new API host.
In the Authentik admin console (`https://auth.aegclouddfir.com/if/admin/`):

**Providers → cdfir → Redirect URIs**, set to exactly:

```
https://api.aegclouddfir.com/auth/callback
```

Confirm the issuer matches `CDFIR_OIDC_ISSUER` character for character —
including the trailing slash:

```bash
curl -s https://auth.aegclouddfir.com/application/o/cdfir/.well-known/openid-configuration | jq .issuer
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
https://api.aegclouddfir.com/api/v1/connectors/callback/microsoft
```

**Google (Cloud Console → Credentials → OAuth client → Authorized redirect URIs):**

```
https://api.aegclouddfir.com/api/v1/connectors/callback/google
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
    "AllowedOrigins": ["https://app.aegclouddfir.com"],
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
curl -sSI https://app.aegclouddfir.com | head -1
curl -sSI https://api.aegclouddfir.com/healthz | head -1

# 2. API is healthy end to end (database reachable)
curl -s https://api.aegclouddfir.com/readyz          # {"status":"ok","checks":{"database":"ok"}}

# 3. OIDC discovery resolves and matches
curl -s https://auth.aegclouddfir.com/application/o/cdfir/.well-known/openid-configuration | jq .issuer

# 4. Login redirects to Authentik (302 to auth.aegclouddfir.com, not localhost)
curl -sI "https://api.aegclouddfir.com/auth/login?redirectTo=/" | grep -i location

# 5. The BROWSER bundle points at the right API (catches a stale web image)
curl -s https://app.aegclouddfir.com/collections/new | grep -o 'api\.example\.com' | head -1

# 6. Front door: apex and www start the login flow (301 -> api/auth/login)
for h in aegclouddfir.com www.aegclouddfir.com; do
  curl -sI "https://$h/" | grep -i '^location'
done

# 7. admin alias reaches the Authentik admin console (301 -> auth/if/admin/)
curl -sI https://admin.aegclouddfir.com/ | grep -i '^location'
```

Then open `https://aegclouddfir.com`, sign in, and confirm you land on
`app.aegclouddfir.com` with `/api/v1/me` returning your identity.

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
