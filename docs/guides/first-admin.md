# Granting the first administrator

A freshly migrated deployment has no tenants, users, or roles. Nobody can do
anything until an operator grants the first administrator.

There is deliberately **no** "first user to sign in becomes admin" rule. On a
platform that holds other people's evidence, that would mean whoever reaches a
newly deployed instance first owns it. Granting the first administrator requires
database credentials, and the grant is written into the tenant's audit chain as
`tenant.bootstrap_admin`.

## Why this takes two passes

The app identifies a user by `(issuer, subject)` from the OIDC token, not by
email. Authentik's `cdfir` provider uses `sub_mode = hashed_user_id`, so the
subject is a salted hash of the internal user id — it cannot be computed or
guessed outside Authentik. Only a real sign-in can create the app's user row.

So the sequence is: create the IdP account → sign in once → grant roles.

## 0. If you cannot log into Authentik at all

`AUTHENTIK_BOOTSTRAP_PASSWORD` and `AUTHENTIK_BOOTSTRAP_EMAIL` are read by the
**worker**, which runs the migrations that create `akadmin`. They also apply only
on the first start against an empty database. If the worker started without them,
`akadmin` exists with no usable password and nobody can reach the admin console.

Check:

```bash
docker compose -f infra/compose/docker-compose.yml exec authentik-server \
  ak shell -c 'from authentik.core.models import User; u=User.objects.get(username="akadmin"); print(u.email, u.has_usable_password())'
```

`False` means there is no password to log in with. Adding the environment
variables now will not help — bootstrap has already run. Mint a one-time
recovery link instead:

```bash
docker compose -f infra/compose/docker-compose.yml exec authentik-worker \
  ak create_recovery_key 1 akadmin
```

Open the printed URL in a browser and set a password. The link is valid for one
day and is itself a credential — treat it like a password: do not paste it into
a ticket, a chat, or anywhere it will be logged.

## 1. Create the Authentik account

In the Authentik admin console (`https://admin.aegclouddfir.com`, or
`https://auth.aegclouddfir.com/if/admin/`), under **Directory → Users**, create
a user whose **email exactly matches** what you will grant. The email is the
only link between the IdP account and the grant below.

Set the password yourself — via **Directory → Users → the user → Set password**,
or by sending a recovery link. To let this person administer Authentik itself,
add them to the **authentik Admins** group; that is separate from any role in
this application.

## 2. Create the tenant

Run this where `CDFIR_DATABASE_URL` is already set, so no credential is typed on
a command line where it would land in shell history and the process list:

```bash
cd /var/www/AEGCloudDFIR
docker compose -f infra/compose/docker-compose.yml exec api \
  node /app/packages/database/dist/bootstrap-cli.js \
    --tenant-slug evestigate \
    --tenant-name "Evestigate" \
    --email someone@example.com
```

Before that person has ever signed in, this creates the tenant, grants nothing,
and exits **3** with an explanation. That is the expected first result.

## 3. Sign in once

Have them open `https://aegclouddfir.com` and complete the Authentik login.

They will land on an error along the lines of *no active membership in this
tenant*. **That is the account being created, not a failure** — the login
succeeded, and the app now has a user row with the right subject.

## 4. Re-run the same command

```bash
docker compose -f infra/compose/docker-compose.yml exec api \
  node /app/packages/database/dist/bootstrap-cli.js \
    --tenant-slug evestigate --tenant-name "Evestigate" \
    --email someone@example.com
```

Now it reports the membership and roles it created. Have them reload the app.

The command is idempotent — safe to re-run at any point. It adds only what is
missing and tells you what changed, so the run/sign-in/re-run cycle needs no
cleanup between passes.

## Options

| Flag | Meaning |
| --- | --- |
| `--roles a,b` | Roles to grant. Default `org_admin`. One or more of `org_admin`, `case_manager`, `reviewer`, `read_only`, `production_manager`, `auditor`. |
| `--platform-admin` | Also set `isPlatformAdmin`. Deployment-operator flag only: it grants **no** access to any tenant's evidence, by design. Keep it separate from tenant roles. |

## Roles it will not touch

Role assignments created here are marked `source = 'local'`. If a role is
already present with `source = 'oidc_group'` (derived from an IdP group via
`CDFIR_OIDC_GROUP_CLAIM` / `CDFIR_OIDC_GROUP_ROLE_MAP`), the command leaves it
alone rather than rewriting it. Converting it to `local` would stop group sync
from managing that role, so removing the person from the IdP group would no
longer revoke their access.

## Adding administrators later

Once someone holds `org_admin`, manage people in the application rather than
here. This CLI exists for the first grant and for recovering an instance whose
last administrator was lost.

## Troubleshooting

**`N users carry the email …`** — two identities share that address, usually
because the OIDC issuer was reconfigured and the same person signed in under a
new subject. The command refuses rather than guessing which identity to make an
administrator. Decide which user row is current and remove or correct the other.

**`tenant "x" exists but is suspended`** — reactivate the tenant first; the
command will not grant administrative access on a non-active tenant.

**Still "no active membership" after step 4** — the email in Authentik does not
match the `--email` value. Compare them exactly (matching is
case-insensitive, but nothing else is normalized), then sign in again.
