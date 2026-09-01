# Connecting Dropbox

You need a Dropbox app before anyone can connect a Dropbox account. You make it
once. It then serves every tenant.

Two halves: the part you do in a browser, and the two lines you add to the
server's `.env`.

## 1. Make the app (browser)

Go to <https://www.dropbox.com/developers/apps> and click **Create app**.

| Question       | Answer            |
| -------------- | ----------------- |
| Choose an API  | **Scoped access** |
| Type of access | **Full Dropbox**  |
| Name your app  | anything unique   |

**Do not pick "App folder".** An app-folder app can only ever see one folder
that it creates itself. It cannot see a single file the custodian already has,
which is the whole job.

The name has to be unique across all of Dropbox, so plain "CloudDFIR" may be
taken. Add your company to it.

## 2. Permissions — do this BEFORE anyone signs in

Open the **Permissions** tab. Tick these and click **Submit**:

- `account_info.read`
- `files.metadata.read`
- `files.content.read`
- `sharing.read`
- `team_data.member` — only if you want organisation-wide collection

**Tick nothing that says write, delete, or admin.** A forensic tool must not be
able to change a custodian's Dropbox. A permission never asked for cannot be
misused by a bug or a stolen token.

Why before: Dropbox writes the permissions into the token at the moment someone
approves it. Adding a permission later does not upgrade tokens that already
exist. The fix is asking every custodian to connect again, so it is worth one
careful minute now.

## 3. Redirect URIs

On the **Settings** tab, find **Redirect URIs** and add these two, one at a
time, exactly as written:

```
https://api-staging.aegclouddfir.com/api/v1/connectors/callback/dropbox
```

```
https://api.aegclouddfir.com/api/v1/connectors/callback/dropbox
```

They must match to the character. A trailing slash, `http` instead of `https`,
or the wrong host gives `redirect_uri did not match`, which reads like a Dropbox
fault and is always a typo.

## 4. Copy the keys

Still on **Settings**, near the top:

- **App key** → this is `CDFIR_DROPBOX_CLIENT_ID`
- **App secret** → click Show → this is `CDFIR_DROPBOX_CLIENT_SECRET`

Treat the secret like a password. It never goes in the repo, in a ticket, or in
a chat message.

## 5. Put them on the server

The keys live in the server's `.env` files, which you edit yourself. Staging and
production are separate files, and both can use the same app.

**[SERVER]** Staging:

```bash
nano /var/www/AEGCloudDFIR/.env.staging
```

**[SERVER]** Production:

```bash
nano /var/www/AEGCloudDFIR/.env
```

In each, add these three lines:

```
CDFIR_DROPBOX_CLIENT_ID=your-app-key
CDFIR_DROPBOX_CLIENT_SECRET=your-app-secret
CDFIR_DROPBOX_REDIRECT_PATH=/api/v1/connectors/callback/dropbox
```

**No quotes.** Compose passes surrounding quotes into the value, so
`CDFIR_DROPBOX_CLIENT_ID="abc"` becomes the literal `"abc"` and every sign-in
fails.

The containers must then be **recreated**, not restarted. `env_file` is read
once, when a container is created, and the running container keeps a frozen copy
— so `docker restart` leaves the old, empty values in place and the check below
still says `NO`. This cost an hour the first time.

**[SERVER]** Recreate staging's api and worker (the worker needs the keys too):

```bash
cd /var/www/AEGCloudDFIR && docker compose -p cdfir-staging --env-file .env.staging -f infra/compose/docker-compose.staging.yml up -d api-staging worker-staging
```

A normal deploy also does this, because it runs `up -d`. These are not
`NEXT_PUBLIC_*`, so no image rebuild is needed.

## 6. Check it took

**[SERVER]** After the restart, confirm the API can see the key without printing
the secret:

```bash
docker exec cdfir-staging-api sh -lc 'echo "id set: $([ -n "$CDFIR_DROPBOX_CLIENT_ID" ] && echo yes || echo NO)"; echo "secret set: $([ -n "$CDFIR_DROPBOX_CLIENT_SECRET" ] && echo yes || echo NO)"'
```

Both must say `yes`. If either says `NO`, the file was edited but the container
was not restarted, or the line has a typo.

## What a custodian sees

They are sent to Dropbox and **made to sign in**, even if their browser is
already signed in to Dropbox. That is deliberate: `force_reauthentication=true`
is on every sign-in URL this product builds.

Without it, Dropbox silently reuses the session in the browser. For an evidence
tool that is a chain-of-custody problem — the wrong person's files get
collected, and nothing in the product says so. There is a test that walks every
sign-in URL builder and fails if a new one skips this.

## Known limits

- Dropbox does not record a file creation time, only when its servers last saw a
  change. Collected files therefore show a modified time and no created time.
- Dropbox's `content_hash` is not a SHA-256 of the file. It is a hash of hashes
  of 4 MiB blocks. It is stored under its own name and never compared with our
  digest.
