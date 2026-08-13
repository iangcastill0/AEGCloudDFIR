# Runbook: backup and restore

## Taking a backup

```bash
cd /var/www/AEGCloudDFIR
./scripts/backup-postgres.sh
```

That dumps PostgreSQL, uploads it to the Wasabi backups bucket, and **verifies
it by reading it back and re-hashing**. A manifest is written alongside each
dump recording its SHA-256, size, PostgreSQL version, and the last applied
migration.

Two details the script exists to get right. Both were found by testing a real
restore, and both produce a backup that looks successful while being unusable:

- **pg_dump must run as a superuser.** Every tenant table carries
  `FORCE ROW LEVEL SECURITY`, which applies to the table *owner* too. Dumping as
  `cdfir_migrator` fails with *"query would be affected by row-level security
  policy"* and yields a dump whose table of contents is complete while the data
  is truncated — `pg_restore --list` cannot detect this.
- **pg_dump's exit code must be checked before uploading.** A shell pipeline
  reports the *last* command's status, so `pg_dump | uploader` returns success
  even when pg_dump died, uploading a partial dump that then verifies against
  itself. The script writes to a temp file and checks the exit code first.

## What to back up

| Store        | Method                                                              | Frequency |
| ------------ | ------------------------------------------------------------------- | --------- |
| PostgreSQL   | `scripts/backup-postgres.sh` (pg_dump -Fc → Wasabi, verified)       | nightly   |
| Object store | Wasabi versioning + Object Lock; content-addressed, nothing to dump | continuous |
| OpenSearch   | none required — rebuildable from PostgreSQL + object store          | —         |
| Redis        | none required — transient job state (the outbox re-dispatches)      | —         |
| **KEK**      | **`CDFIR_KEK_LOCAL_MASTER_KEY` — to a password manager, by hand**   | on change |

### The KEK is not in the backup, and must not be

Connector secrets in the database are envelope-encrypted with
`CDFIR_KEK_LOCAL_MASTER_KEY`, which lives in `.env`, not in PostgreSQL. A dump
restored without that key leaves every connector credential permanently
undecryptable.

Store it in a password manager. **Do not put it in the backups bucket** — a
backup that carries its own decryption key is not encrypted in any meaningful
sense, and one compromise would yield both halves.

## Listing and fetching a backup

```bash
docker compose -f infra/compose/docker-compose.yml exec -T worker \
  node /app/packages/database/dist/restore-cli.js --list

docker compose -f infra/compose/docker-compose.yml exec -T worker \
  node /app/packages/database/dist/restore-cli.js --key <objectKey> > restore.dump
```

Keys sort chronologically, so the newest backup is last in the listing.

The fetch verifies the SHA-256 against the manifest **before writing a single
byte to stdout**, so a corrupted backup can never reach `pg_restore`. It
deliberately does not run `pg_restore` itself: restoring is an explicit act
against a database an operator has chosen, not something a tool should do on
your behalf.

## Restoring

Restore into a **new** database first and inspect it. Never restore straight
over a live one.

```bash
# 1. fetch and verify (above), then copy the dump into the postgres container
docker cp restore.dump cdfir-postgres-1:/tmp/restore.dump

# 2. create a scratch target
docker exec -it cdfir-postgres-1 psql -U postgres -c "CREATE DATABASE cdfir_restored"

# 3. restore
docker exec -it cdfir-postgres-1 \
  pg_restore -U postgres -d cdfir_restored --no-owner /tmp/restore.dump

# 4. sanity-check row counts before trusting it
docker exec -it cdfir-postgres-1 psql -U postgres -d cdfir_restored -c \
  "select (select count(*) from tenants), (select count(*) from users),
          (select count(*) from memberships), (select count(*) from audit_events)"
```

Only once that looks right, point the application at it (or rename databases).

## Verification after restore — proven, not assumed

The following were confirmed end to end against a real PostgreSQL 16 and a real
object store, not just documented:

- the fetched dump is **byte-identical** to what was uploaded
- row counts match the source exactly
- **`FORCE ROW LEVEL SECURITY` survives on all 49 tables** — a restore does not
  quietly drop tenant isolation
- `pg_restore` exits 0

Also run, per tenant:

- `pnpm audit:verify` — the audit hash chain must still verify
- spot-verify a sample of evidence blobs: compare the stored SHA-256 against a
  fresh hash of the object in Wasabi

## Restore order after losing the host

1. Restore PostgreSQL from the newest verified backup.
2. Put `CDFIR_KEK_LOCAL_MASTER_KEY` and the other `.env` secrets back from your
   password manager — without the KEK, connector credentials cannot be decrypted.
3. Verify audit chains (`pnpm audit:verify`, exit 0).
4. Point services at the object store. Objects are content-addressed and were
   never lost; nothing to restore unless the bucket itself was destroyed.
5. Rebuild the search index from PostgreSQL + object store.
6. Restart workers. Collections that were mid-flight resume from their
   checkpoints; confirm on the collection status page.
