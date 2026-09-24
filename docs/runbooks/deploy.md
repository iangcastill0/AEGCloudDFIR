# Deploying

Three pieces, deliberately separate:

| Workflow      | Trigger                          | What it does                                          |
| ------------- | -------------------------------- | ----------------------------------------------------- |
| `ci.yml`      | every push and PR                | format, lint, typecheck, tests, build, migrations+RLS |
| `release.yml` | CI finishing **green** on `main` | builds and pushes app and parser images to GHCR       |
| `deploy.yml`  | you, by hand                     | pulls images, applies migrations, and verifies them   |

Nothing deploys itself. Images exist only for commits that passed CI, and
replacing what is running is always a human decision.

## One-time setup

### 1. Images are already pullable

Verified on 2026-08-18: `docker pull ghcr.io/iangcastill0/aegclouddfir/api:<tag>`
succeeds from the server with no login, because the packages inherit this
repository's public visibility. Nothing to do.

They contain code, not secrets — every credential is read from `.env` on the
server at runtime. If you ever make the repository private, the packages follow,
and the server will then need `docker login ghcr.io` once with a `read:packages`
token.

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

| Variable                    | Value                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `CDFIR_DEPLOY_TARGET`       | `root@74.207.235.208`                                                                             |
| `CDFIR_SSH_KNOWN_HOSTS`     | `74.207.235.208 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIAagaEGGkqSIOSgrh5VvwXTpa8vsd8zD0+O/tyb1iSX` |
| `CDFIR_DEPLOY_PATH`         | `/var/www/AEGCloudDFIR` (optional — this is the default)                                          |
| `NEXT_PUBLIC_API_URL`       | `https://api.aegclouddfir.com` (optional — this is the default)                                   |
| `NEXT_PUBLIC_AUTHENTIK_URL` | `https://auth.aegclouddfir.com` (optional — this is the default)                                  |

The host key is pinned rather than accepted on first use, so a hijacked DNS
record cannot harvest the deploy key. If you ever rebuild the server, refresh it
with `ssh-keyscan -t ed25519 <ip> | grep -v '^#'`.

**Moving hosts means changing three things, not one.** After the 2026-09-15 move
to the Linode, both variables still named the old box, and the deploy key was
not on the new one. A deploy would have SSH'd to the retired server, succeeded,
and changed nothing users could see — the failure this project has hit before in
the other direction. The three:

1. `CDFIR_DEPLOY_TARGET` — the new `user@ip`
2. `CDFIR_SSH_KNOWN_HOSTS` — the new host's key, or CI refuses to connect
3. The `github-actions-deploy` **public** key in the new host's
   `authorized_keys`, or CI cannot log in

Check all three agree before trusting a green deploy:

```bash
gh variable list -R <owner>/<repo>
ssh <newhost> 'ssh-keygen -lf ~/.ssh/authorized_keys'   # look for github-actions-deploy
ssh-keyscan -t ed25519 <new-ip> | grep -v '^#'          # must equal the variable
```

If `gh` fails with `Unable to read current working directory`, that is macOS
blocking your terminal, not a broken repo. Add `-R <owner>/<repo>` and it stops
needing to resolve the repo from the current folder.

Then prove it with a **staging** deploy, which needs no reviewer, and verify by
tag rather than by the green tick:

```bash
ssh <newhost> 'grep CDFIR_IMAGE_TAG /var/www/AEGCloudDFIR/.env.staging'
```

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

## Disk cleanup, which the deploy does for you

At the end of a healthy deploy — never a failed one — the script deletes old
image tags. It keeps the newest 3 per repository, plus whatever any container is
running, plus the tag it would roll back to.

Why it is there: each deploy pulls three images, about 3.7 GB. Staging and
production share one 98 GB disk. Around ten deploys in a day filled it on
2026-08-27, and PostgreSQL on staging crashed and then could not restart,
because replaying its own log needs space too.

To see what it would delete without deleting anything, run only the prune
function — do **not** source the whole script, that would run a real deploy.
The host needs the updated `scripts/deploy.sh`, so this works after the first
deploy that carries it:

```bash
ssh cdfir-server 'cd /var/www/AEGCloudDFIR && { echo "set -u; TAG=$(grep ^CDFIR_IMAGE_TAG= .env | cut -d= -f2); PREVIOUS_TAG=\$TAG; PRUNE_DRY_RUN=1"; awk "/^# Reclaim old image tags/,/^}\$/" scripts/deploy.sh; echo prune_old_images; } | bash'
```

Or simpler, just look at the space:

```bash
ssh cdfir-server 'docker system df; df -h /'
```

Keep more or fewer tags with `KEEP_PER_REPO`. It only ever considers this
project's own repositories, so shared images like `postgres` and `opensearch`
can never be selected.

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
