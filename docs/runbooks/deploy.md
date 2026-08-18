# Deploying

Three pieces, deliberately separate:

| Workflow      | Trigger                          | What it does                                          |
| ------------- | -------------------------------- | ----------------------------------------------------- |
| `ci.yml`      | every push and PR                | format, lint, typecheck, tests, build, migrations+RLS |
| `release.yml` | CI finishing **green** on `main` | builds and pushes `api`/`web`/`worker` images to GHCR |
| `deploy.yml`  | you, by hand                     | pulls a published tag onto the server and verifies it |

Nothing deploys itself. Images exist only for commits that passed CI, and
replacing what is running is always a human decision.

## One-time setup

### 1. Make the images pullable

After the first `release.yml` run, three packages appear at
<https://github.com/iangcastill0?tab=packages>. Each is private by default — set
`aegclouddfir/api`, `aegclouddfir/worker` and `aegclouddfir/web` to **public**
(Package settings → Change visibility). The repository is already public and the
images contain code, not secrets: every credential is read from `.env` on the
server at runtime.

Prefer to keep them private? Then run `docker login ghcr.io` on the server once
with a read-only PAT (`read:packages`) instead.

### 2. Create the deploy key

**Do this yourself. Nobody else, including Claude, should ever see the private
half.** On your Mac:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cdfir-deploy -C "github-actions-deploy" -N ""
```

Authorize the public half on the server:

```bash
ssh-copy-id -i ~/.ssh/cdfir-deploy.pub cdfir-server
```

Then copy the **private** key to your clipboard and paste it into GitHub as a
repository secret named `CDFIR_DEPLOY_SSH_KEY`
(Settings → Secrets and variables → Actions → New repository secret):

```bash
pbcopy < ~/.ssh/cdfir-deploy
```

Consider restricting what that key may do in `~/.ssh/authorized_keys` on the
server — a deploy key does not need an interactive shell forever, and this one
can replace production containers.

### 3. Add the repository variables

Settings → Secrets and variables → Actions → **Variables**:

| Variable                    | Value                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `CDFIR_DEPLOY_TARGET`       | `ian@38.248.7.156`                                                                              |
| `CDFIR_SSH_KNOWN_HOSTS`     | `38.248.7.156 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDMB2YnlrTAXNHou9evfR7otouV6r6x6pGHO3s9ajWpP` |
| `CDFIR_DEPLOY_PATH`         | `/var/www/AEGCloudDFIR` (optional — this is the default)                                        |
| `NEXT_PUBLIC_API_URL`       | `https://api.aegclouddfir.com` (optional — this is the default)                                 |
| `NEXT_PUBLIC_AUTHENTIK_URL` | `https://auth.aegclouddfir.com` (optional — this is the default)                                |

The host key is pinned rather than accepted on first use, so a hijacked DNS
record cannot harvest the deploy key. If you ever rebuild the server, refresh it
with `ssh-keyscan -t ed25519 <ip>`.

### 4. Turn on the approval gate

Settings → Environments → **New environment** → name it `production` → tick
**Required reviewers** and add yourself.

Without this, `deploy.yml` still only runs when you click it — but with it,
GitHub holds the job for an explicit approval and records who approved each
deploy, which is what you want on a system holding evidence.

## Deploying

Actions → **Deploy** → Run workflow → `ref` = `main` (or any commit/tag that
passed CI) → Run → approve.

It refuses commits whose CI was not green, moves the server's checkout to that
exact commit, pulls the matching images, restarts `api`/`worker`/`web`, and then
verifies `/readyz` (database **and** object storage) plus the public site through
nginx. **Any failure rolls back to the previously deployed tag automatically.**

Tick `dry_run` to see what a deploy would do without changing anything.

## Rolling back

Re-run **Deploy** with an earlier `ref`. Or on the server:

```bash
cd /var/www/AEGCloudDFIR && ./scripts/deploy.sh sha-1a2b3c4
```

The tag currently deployed is recorded as `CDFIR_IMAGE_TAG` in the server's
`.env`, so a later plain `docker compose up -d` brings back the same images
rather than something else.

## Things that will bite you

- **`NEXT_PUBLIC_*` are baked into the browser bundle at image build time.**
  Changing a domain needs a new image, not a restart. A wrong value here is what
  made the site fail every API call with "failed to fetch" on 2026-08-14.
- **Always pass `--env-file`** when running compose by hand. Interpolation reads
  the `.env` in the _current_ directory, not the services' `env_file`. Running
  from `infra/compose` without it applies every default: colliding host ports and
  `changeme-local-only` as the database password. The deploy script always passes
  it explicitly, and the server has `infra/compose/.env` symlinked to the root
  `.env` so either invocation works.
- **The first deploy has nothing to roll back to.** `CDFIR_IMAGE_TAG` is not yet
  in `.env`, so the script says so loudly instead of pretending. Deploy once
  while you are watching.
- **Migrations run when the worker boots.** A deploy that includes a schema
  change applies it. Take a backup first (`scripts/backup-postgres.sh`) for
  anything you cannot undo.
