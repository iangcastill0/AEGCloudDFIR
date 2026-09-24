# ADR-013: Downloading an export as one folder, and a digest per part

Status: proposed · Date: 2026-09-22

## Context

A finished export is several files. The 130 GiB `winder 3` export on production
is **65 archive parts plus a manifest**. Today the download UI lists them as 65
links; an operator clicks each one and 65 files land loose in `~/Downloads`,
mixed in with everything else, named `export-part001.zip` onward.

Three things make that worse than it sounds.

**A browser cannot create a folder from a download.** Path separators are
stripped from both the HTML `download` attribute and the `Content-Disposition`
filename. No naming scheme groups the parts, so this is not a cosmetic problem
with a cosmetic fix — it needs a different mechanism.

**The links expire before you can use them all.**
`CDFIR_S3_PRESIGN_TTL_SECONDS` is 300. Sixty-five parts cannot all be started
inside five minutes at any realistic speed, so the later links begin returning
403 part-way through.

**A downloaded part cannot be checked.** `putDerivative` computes a SHA-256 for
every part and `runNativeExport` threw it away. The manifest hashes every
evidence ITEM, which proves the contents once extracted, and says nothing about
whether a 2 GiB part arrived intact. The only way to detect a truncated part
was to unzip all 130 GiB and hash 434,878 items.

Measured on the production bucket (Wasabi) on 2026-09-22, because it decides
what is possible: `Access-Control-Allow-Origin: *`, `GET` allowed, and
`Accept-Ranges` / `Content-Range` exposed. So browser `fetch()` against a
presigned URL works, and range requests work, which means resumable transfers
are available to both paths below.

## Decision

### 1. A digest per archive part, in its own table

`export_parts` holds `(exportId, partNumber, objectKey, sha256, sizeBytes)`,
written in the same transaction that marks an export `ready`. An export that
says ready without part digests is one a recipient cannot check, and there
would be nothing to say so.

Its own table rather than a field in `manifest.json` because the manifest is
written INSIDE the final archive part. Using it to verify the parts means
trusting a part to vouch for itself.

Exports produced before this have no rows. The download path reports
`sha256: null` for them, meaning **cannot verify** — never omitted, never
defaulted to something that reads like success.

### 2. Two download paths, chosen by size

**Script, for large exports.** A generated `download-<folder>.sh` or `.ps1`
creates the folder, fetches URLs at run time, resumes a broken part with
`curl -C -`, and finishes with the verify command. This is the recommended path
past 8 parts or 10 GiB, and it works on every browser.

**Browser folder save, for small ones.** `showDirectoryPicker()` creates the
folder and streams each part into it. Chromium only; Firefox and Safari fall
through to the script.

The size thresholds are not arbitrary. Everything about a browser save has to
survive one sitting — tab open, machine awake, and a failure part-way restarts
that part from zero. At 65 parts that is a bad bet; at two it is fine.

They are **not** raised now that the browser path re-signs its own links. Link
expiry stopped being one of the reasons, but resume never was one of the
browser's abilities and still is not. That is the cost that grows with part size,
and it is what the thresholds are really measuring.

### 3. A scoped token, so a script can re-sign as it goes

Presigned URLs stay at 300 seconds. Their job is to reach bytes, and a leaked
one should die quickly. What changes is that a script can ask for fresh ones:
`POST /exports/:id/download/urls`, authenticated by a token that reaches **one
export, read-only**, for `CDFIR_EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS` (default 24h).

The alternative was raising the presign TTL to cover a whole download. Rejected:
that widens the window on 65 URLs that each reach evidence directly, where this
widens it on one credential that is scoped, audited on every use, and useless
against any other export.

The token is a stateless HMAC, keyed by a value **derived** from
`CDFIR_SESSION_SECRET` rather than the secret itself, so a flaw in one does not
become a flaw in both and either can be rotated.

Two limits, both deliberate and both documented in `download-token.ts`:

- **It cannot be revoked before it expires.** The export's own `expiresAt` is
  re-checked on every refresh, so a retired export stops being reachable
  regardless of the token.
- **It does not re-check roles on use.** A user whose access is removed
  mid-download keeps this one export until the token expires.

A table would fix both, at the cost of a row on the hot path of every part
fetch. The blast radius is one export the holder was authorised to download at
the moment it was issued, so the trade is worth taking — but it is a trade, and
the TTL is the dial that controls it.

**This route is the only one exempt from the global CSRF guard**, marked with
`@SkipCsrf()`. It has to be: `curl` and PowerShell have no cookie jar, so they
can never send back a matching double-submit pair, and without the exemption the
first refresh returned `403 CSRF token missing or invalid` and every long
download died at the five-minute mark.

Safe because the route authenticates by `Authorization: Bearer` **alone**. CSRF
is an attack on credentials the browser attaches by itself; it cannot attach an
`Authorization` header without a preflight the attacker's origin fails. The
handler has no session guard and never reads a cookie, so there is nothing for a
cross-site request to ride in on. The day it accepts a session, the exemption has
to go with it.

`apps/api/src/security/csrf-exemptions.test.ts` walks every route on every
controller and fails unless the exempt set is exactly this one, in the spirit of
the `prompt=select_account` registry in `packages/connectors/src/oauth.test.ts`.
Adding a second exemption quietly is what that test exists to stop.

The browser folder save re-signs the same way, through the same endpoint with the
same token and `credentials: 'omit'`. It is sequential, and expiry is checked when
a request STARTS, so one slow part is fine but a part taking over 300 seconds
handed the NEXT part a dead URL. One refresh per file, then it fails and names
the file — a loop would be a save that never finishes and never says why.

### 4. Verification travels with the download

Every path writes `hashes.txt` (`sha256sum -c` format) and a `README.txt` into
the folder.

**Every line of `hashes.txt` is a real `DIGEST  FILENAME` line. No comments.**
This is the same rule the archive's own `hashlist.txt` follows, and it has to be:
both files get checked with the same command by the same person, so they cannot
disagree. Measured on macOS 27, a `#` line makes the bundled `sha256sum -c` print
`WARNING: 1 line is improperly formatted`, and `--strict` makes it exit 1 — a
perfect transfer reported as a failure — while `shasum -a 256 -c` skips the same
line in silence. One file, two answers, is not something to hand a recipient who
may have to explain it.

A part with no recorded digest is **not** dropped instead. It is named in
`unverifiable-parts.txt` and counted in `README.txt`, which also says that the
verify command will report OK without having checked it. A short `hashes.txt`
that passes `-c` looks exactly like a complete one, and that would turn "cannot
verify" into a silent "verified".

The README separates two claims that are easy to conflate. Passing `hashes.txt`
says the parts arrived intact. It does not say the evidence inside them matches
the manifest — that is `hashlist.txt`, after extraction.

Nothing is hashed in the browser. `crypto.subtle.digest` needs the whole buffer,
and holding 2 GiB in memory to check it trades a download problem for an
out-of-memory one. The folder gets the material to verify offline instead, in
one command.

## Consequences

The existing `archiveUrls` array stays in the download response alongside the
new `parts`, so nothing breaks while the web app moves over.

`export.downloaded` audit events now carry `verifiable`, recording whether the
export had part digests at all. Refreshes are audited too, with `viaToken`.
A 65-part download that refreshes as it goes writes several rows — that is the
intended record: each one handed out fresh reach to evidence.

**`winder 3` has no part digests**, because it was produced before this.
`apps/worker/src/backfill-export-part-hashes.ts` fills them in by re-reading
and hashing each part — 130 GiB of reads and a few hours, streamed, resumable,
read-only against object storage. It records an audit event per part saying the
digest was **backfilled**, because a hash computed today describes the object as
it is now and is not evidence about what was written at export time.

A new migration (`20260922000013_export_parts`) must be applied before the API
that reads the table. Production is still behind on `20260918000012`, and no
deploy workflow runs migrations.
