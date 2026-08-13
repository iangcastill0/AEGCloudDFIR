# Switching evidence storage to Wasabi

The deployment currently writes evidence to the MinIO container, which is fine
for testing and **not** suitable for real matters — it is a single container on
one host with no offsite durability. This guide replaces it with Wasabi.

Good news on timing: the evidence bucket holds **0 objects** and no evidence rows
exist, so this is a clean cutover with nothing to migrate. Doing it before the
first real collection avoids ever having to move custody-bearing bytes between
stores.

## Read this first: one decision you cannot undo

**Object Lock can only be enabled when a bucket is created.** You cannot add it
to an existing bucket. If you intend to rely on WORM retention, you must decide
now, at bucket-creation time.

This matters for how the platform describes itself. It probes the bucket and
reports only what it finds:

| Bucket state | What the platform reports |
| --- | --- |
| Versioning + Object Lock | "WORM retention applies" |
| Versioning only | "protected by application logic and IAM policy only (no WORM guarantee)" |
| Neither | "protected by application logic and IAM policy only (no WORM guarantee)" |

It will never claim WORM that the bucket cannot actually provide. So if you want
the stronger statement in your custody documentation, create the bucket with
Object Lock enabled from the start.

**Compliance vs Governance mode**, if you enable it:

- **Governance** — a user holding `s3:BypassGovernanceRetention` can shorten or
  remove retention. Recoverable if you misconfigure it.
- **Compliance** — nobody can shorten or delete before expiry, including the
  root account and Wasabi support. Objects are billed until retention expires.

Compliance mode is the stronger evidentiary posture and the more dangerous
operational one. A default retention of, say, 7 years on compliance mode means a
mistaken upload is billable for 7 years and cannot be deleted. **Start with
Governance mode** unless you have a specific written retention obligation, and
set the default retention period deliberately — not to a placeholder.

## Step 1 — Create two buckets

In the Wasabi console → **Buckets** → **Create Bucket**:

| Bucket | Purpose | Suggested name |
| --- | --- | --- |
| Evidence | originals, derivatives, exports, productions | `aeg-clouddfir-evidence` |
| Quarantine | files ClamAV flagged as malware | `aeg-clouddfir-quarantine` |

Bucket names are globally unique across all Wasabi customers, so add a suffix if
these are taken. Both must be in the **same region**.

For the **evidence** bucket:

- **Bucket Versioning: enabled.** Required. The store writes content-addressed
  originals and relies on versioning as its recovery floor.
- **Object Lock: enable now** if you want WORM (see above). Enabling it forces
  versioning on.
- **Default Object Retention: enable it, with a real period.** This is not
  optional decoration. Enabling Object Lock only makes retention *possible* —
  objects acquire it from a bucket default or from a per-object value set at
  upload, and this application never sets per-object retention (it holds no
  `s3:PutObjectRetention` grant, deliberately). With Object Lock on and no
  default rule, **not one object is retained** and you have the cost and rigidity
  of Object Lock with none of the protection. The platform detects exactly this
  case and says so rather than claiming WORM.

Choosing the default retention period:

- The rule applies to **every** object written to the bucket — not just
  originals, but derivatives, previews, extracted text, exports and productions,
  all of which are regenerable from the originals. Under Compliance mode they are
  all undeletable and billable for the full period.
- Changing the default later affects **newly uploaded objects only**; existing
  objects keep the retention they were given.
- So if you do not yet have a written retention obligation, set something modest
  now (30 days is reasonable while testing) in **Governance** mode, and raise it
  deliberately before the first real matter. Starting at 7 years on Compliance
  mode locks every test artefact you create for 7 years.

### Why there are two buckets

The quarantine bucket holds objects ClamAV flagged as infected. It **isolates,
it does not destroy**: on a forensic platform the malware is frequently the
evidence in dispute, so the bytes are preserved, the item is marked
`malwareStatus: infected`, and download is locked behind an explicitly audited
`org_admin` override.

A separate bucket rather than a `quarantine/` prefix, for four reasons:

- **Object Lock cannot be applied selectively.** A prefix inside the evidence
  bucket would inherit its default retention, so quarantined malware could never
  be purged even when you legitimately need to.
- **CORS is per-bucket.** The evidence bucket allows browser `GET` for previews;
  quarantine must never be browser-reachable.
- **Exclusion becomes structural.** Exports and productions read the evidence
  bucket, so malware living elsewhere makes "never produce this" a property of
  where the bytes are rather than a filter someone can forget to apply.
- **Lifecycle rules are per-bucket**, so malware can carry a shorter retention
  than evidence.

For the **quarantine** bucket: versioning is optional and Object Lock is a
liability — you may legitimately need to purge malware. Leave Object Lock off.

**Consequence of enabling Object Lock on the evidence bucket.** When an object is
quarantined the worker copies it across and then attempts to delete the
evidence-bucket original. Object Lock will refuse that delete, by design. So
infected bytes exist in **both** buckets until the evidence bucket's retention
expires. The outcome is recorded rather than assumed — protection in that window
is application-level (marked infected, download gated and audited, excluded from
production), not physical. This is an inherent trade of Object Lock, and worth
knowing before someone asks where the malware went.

Do **not** enable Wasabi's automatic compression or encryption-at-rest key
rotation features on the evidence bucket without telling me first. The platform
verifies a SHA-256 over the bytes it stored; anything that transforms objects
server-side needs to be checked against that verification path before it is
trusted.

## Step 2 — Create a dedicated sub-user (not your root keys)

Wasabi console → **Users** → **Create User**:

- Type: **Programmatic (API) access** only. No console access.
- Do not add it to any group with broader rights.
- Create an access key for it. You will need the key pair in Step 5.

Root account keys would give the application the ability to delete buckets,
change Object Lock, and read billing. It needs none of that.

## Step 3 — Attach a least-privilege policy

Wasabi console → **Policies** → **Create Policy**, then attach it to the user.
Replace both bucket names with yours.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EvidenceObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::aeg-clouddfir-evidence/*"
    },
    {
      "Sid": "EvidenceBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": "arn:aws:s3:::aeg-clouddfir-evidence"
    },
    {
      "Sid": "QuarantineObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::aeg-clouddfir-quarantine/*"
    },
    {
      "Sid": "QuarantineBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::aeg-clouddfir-quarantine"
    }
  ]
}
```

The two buckets get **different** grants, because they see different operations.

Quarantine needs these, each traceable to a call site:

- `s3:PutObject` — the destination of the server-side copy in
  `promoteToOriginal(..., { quarantine: true })`.
- `s3:GetObject` — the post-copy size verification (HEAD), and `getStream` when a
  quarantined blob is re-scanned.
- `s3:DeleteObject` — `deletion-run` purges quarantined objects when a deletion
  request covers them.
- `s3:ListBucket` — same `NotFound`-vs-`AccessDenied` requirement as the evidence
  bucket. `promoteToOriginal` HEADs the destination first to avoid overwriting,
  and treats `NotFound` as "safe to copy"; anything else aborts the promotion.
- `s3:AbortMultipartUpload` / `s3:ListMultipartUploadParts` — quarantining an
  object over 5 GiB copies it in with a multipart copy, and a failure partway
  must abort or the parts are billed and invisible to a bucket listing.

Quarantine deliberately does **not** get
`s3:GetBucketVersioning` / `s3:GetBucketObjectLockConfiguration`:
`detectBucketProtection()` probes only the evidence bucket, because that is the
bucket whose protection posture the platform makes claims about.

Why the evidence grants are needed — none is padding:

- `PutObject` / `GetObject` / `DeleteObject` — write originals and derivatives,
  read them back for verification and presigned download, and clean up staged
  objects that failed hash verification.
- `AbortMultipartUpload` / `ListBucketMultipartUploads` /
  `ListMultipartUploadParts` — the store uploads through
  `@aws-sdk/lib-storage`, which uses multipart for anything large. Without abort
  rights, a failed 10 GB PST upload leaves unfinished parts that you are billed
  for and cannot clean up.
- **`ListBucket` — do not omit this.** Without it, a HEAD on a missing object
  returns `AccessDenied` instead of `NotFound`. The store's `headOrNull` treats
  `NotFound` as "not there yet" and rethrows anything else, so omitting
  `ListBucket` breaks the stage → verify → promote path on every new object.
- `GetBucketVersioning` / `GetBucketObjectLockConfiguration` — how the platform
  determines what to honestly claim about protection. Without these it cannot
  read the posture and will not assert WORM.

Deliberately **not** granted: `DeleteBucket`, `PutBucketVersioning`,
`PutObjectRetention`, `BypassGovernanceRetention`, or anything `s3:*`. The
application never needs to weaken the protections it reports on. If you later
want per-object retention set by the app rather than by bucket default, that
needs `s3:PutObjectRetention` added consciously.

### Quarantine bucket settings

| Setting | Value | Why |
| --- | --- | --- |
| Object Lock | **off** | You must be able to purge malware. Locking it removes that option permanently. |
| Versioning | off (optional) | Keys are content-addressed by SHA-256, so an "overwrite" is byte-identical and version history carries no information. |
| CORS | **none** | `presignGet` always signs against the evidence bucket, so a quarantined object can never be handed to a browser. Adding CORS here would create reachability the application does not need. |
| Public access | blocked (default) | — |

### Objects over 5 GiB

S3-compatible APIs cap a **single-part** server-side copy at 5 GiB, while
`CDFIR_UPLOAD_MAX_BYTES` defaults to 10 GiB. Promotion now detects this and
copies anything larger part by part with `UploadPartCopy`, so the full 10 GiB
ceiling works. A failed multipart copy is aborted, because abandoned parts are
billed and do not show up in a bucket listing.

This is why both buckets need `s3:AbortMultipartUpload` — quarantine included,
since an infected object over 5 GiB is moved across with the same mechanism.

## Step 4 — CORS: nothing to do

**Skip this. Wasabi does not support the S3 CORS configuration API**, so there is
nothing to paste — not XML, not JSON. Attempting it returns an invalid-format
error. Wasabi instead returns a fixed set of CORS headers on every response.

Verified against a live bucket, including a real presigned URL (headers are
returned even on a 404):

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, POST, PUT, DELETE, MOVE, OPTIONS
Access-Control-Allow-Headers: *
Access-Control-Expose-Headers: Date, Etag, Content-Length, Accept-Ranges, Content-Range, ...
Access-Control-Max-Age: 86400
```

`Etag` and `Content-Length` are already exposed, so browser previews and
downloads work with no configuration.

### You cannot restrict the origin, and why that is tolerable

`Access-Control-Allow-Origin: *` is broader than you would choose, and on Wasabi
it cannot be narrowed — the headers are not configurable. Do not plan around
tightening it.

The exposure is narrower than `*` suggests. A presigned URL is a **bearer
credential**: anyone holding it can fetch the object with curl, no browser and no
CORS involved. CORS governs only whether JavaScript on another origin may read
the response, so `*` does not widen who can reach evidence — it means a page on
another origin could read a presigned URL's contents *if it already had the URL*,
and holding the URL was already sufficient.

The controls that actually bound this, all already in place:

- `CDFIR_S3_PRESIGN_TTL_SECONDS` (default 300) — the real limit. Keep it short.
- Presigned URLs are never logged or audited (enforced in `evidence.service.ts`).
- A URL is only minted after an authenticated, role-checked, audited API call.

True origin restriction would require fronting the bucket with a CDN or proxy you
control. That is a deliberate architectural choice, not a bucket setting.

## Optional bucket features: what to enable and what to skip

Neither of these is required — no code path reads either one, and
`detectBucketProtection()` probes only versioning and Object Lock. Both can be
turned on later, unlike Object Lock.

### Bucket logging — recommended

Worth enabling, because it closes a gap the application cannot close itself.

Downloads are audited (`evidence.native_downloaded`, `export.downloaded`) at the
moment a **presigned URL is issued**, not when bytes are fetched — the URL is
deliberately never logged. So the audit chain cannot show whether the bytes were
actually retrieved, how many times inside the TTL, or from where, because those
requests go straight to Wasabi and never reach the API. Nor can it show access
made with the S3 credentials directly, bypassing the application. Bucket logging
is the only record of either.

Treat the result as corroborating evidence, not as an audit control. Server
access logs are best-effort and delayed, so they do not meet the standard the
hash-chained audit log does and must not be used to support a completeness
claim.

Configuration:

- **Log to a separate bucket.** Never into the evidence bucket: it pollutes the
  content-addressed namespace, the log objects inherit Object Lock retention, and
  log writes generate further log entries.
- **No Compliance-mode Object Lock on the log bucket.** Logs grow without bound
  and must remain prunable.
- Add a lifecycle rule expiring logs after your retention window, and remember
  the 90-day minimum storage duration applies to them too.

### Object Replication — skip for now

It protects against a different failure than versioning and Object Lock do:
those prevent modification and deletion of evidence, replication protects against
losing the whole bucket or region. The integrity property is the one that matters
for custody, and it is already covered.

It roughly doubles storage spend, the 90-day minimum applies to the replica, and
replication is asynchronous — so it is not a consistency or verification
mechanism. Because it can be enabled at any time, deferring costs only the window
before you turn it on.

If you do enable it later:

- The **destination bucket needs its own Object Lock**, created with it enabled.
  A replica in an unlocked bucket is a deletable copy of protected evidence.
  Confirm against Wasabi's documentation whether retention metadata is carried
  across replication and under what conditions.
- **Write down which copy is authoritative.** The platform treats the
  content-addressed object in the evidence bucket as the record. A replica is a
  backup, not a second custody record; restoring from one is an event worth
  documenting, because "which copy did this hash come from" is a fair question.

A note on priorities: the likelier loss scenario is not Wasabi losing a region,
it is PostgreSQL going away. Evidence bytes are content-addressed and immutable,
but the custody chain, audit hash-chain, tags and review work live in Postgres.
Losing it leaves verifiable bytes with no record of what they are or who touched
them. Database backups deserve attention before bucket replication.

## Step 5 — The endpoint and region must match

Wasabi's endpoint hostname encodes the region, and the region in the config is
used to compute the request signature. **If the two disagree, every request fails
with a signature error**, which reads confusingly as an authentication problem.

Look up the endpoint for your bucket's region in Wasabi's own documentation
("Wasabi service URLs") rather than trusting a list from memory — they add
regions. The pattern is `https://s3.<region>.wasabisys.com`, with `us-east-1`
being the historical exception that also answers on `https://s3.wasabisys.com`.
Confirm yours in the console: the bucket's detail page shows its region.

## Step 6 — What I need from you, and how to hand it over

**Do not paste the secret key into this chat.** Anything in a chat transcript is
retained, and a Wasabi secret key grants read access to evidence. I do not need
to see it — I only need it present in the server's `.env`, which is already mode
`0600` and gitignored.

Edit `/var/www/AEGCloudDFIR/.env` on the server yourself and set these eight
keys:

```bash
CDFIR_S3_ENDPOINT=https://s3.<your-region>.wasabisys.com
CDFIR_S3_REGION=<your-region>
CDFIR_S3_BUCKET_EVIDENCE=aeg-clouddfir-evidence
CDFIR_S3_BUCKET_QUARANTINE=aeg-clouddfir-quarantine
CDFIR_S3_ACCESS_KEY_ID=<the sub-user's access key id>
CDFIR_S3_SECRET_ACCESS_KEY=<the sub-user's secret key>
CDFIR_S3_FORCE_PATH_STYLE=true
CDFIR_S3_PRESIGN_TTL_SECONDS=300
```

`CDFIR_S3_FORCE_PATH_STYLE=true` is correct for Wasabi with a regional endpoint
and avoids DNS-propagation problems on newly created buckets.

Then tell me in chat only these non-secret facts, so I can verify against what
you intended:

1. The two bucket names
2. The region
3. Whether you enabled Object Lock, and if so Governance or Compliance and the
   default retention period

That is enough for me to run the cutover and verification. The access key ID is
not secret in the way the secret key is, but there is no reason to send it —
it is already in `.env` where I can read it on the server.

## Step 7 — What I will do and verify

Once `.env` is set, I will:

1. Restart `api` and `worker` so they pick up the new configuration.
2. Confirm both buckets are reachable and writable by that sub-user.
3. Run a round-trip: write a known byte string, read it back, and confirm the
   SHA-256 matches — proving nothing transforms objects in transit or at rest.
4. Confirm a missing object returns `NotFound` and not `AccessDenied`, which is
   the `ListBucket` trap above.
5. Report exactly what `detectBucketProtection()` says about versioning and
   Object Lock, using its wording, not a rosier paraphrase.
6. Confirm a presigned URL is fetchable. (Wasabi's CORS headers are fixed and
   permissive, so there is no origin configuration to validate — see Step 4.)
7. Leave MinIO running but unused until you confirm you are happy, then it can be
   removed from the compose profile.

## Wasabi-specific cost behaviour worth knowing

Wasabi bills a **minimum storage duration** (90 days at time of writing) — an
object deleted or overwritten before that still accrues charges for the
remainder. Two consequences for this platform:

- Deletion workflows free space but not cost until the minimum elapses.
- Versioning means overwrites retain prior versions, each billed under the same
  rule. That is a feature for evidence integrity; budget for it rather than being
  surprised.

Confirm the current figure in Wasabi's pricing terms — this is the kind of detail
that changes.

## Rolling back

Nothing destructive happens to MinIO during the cutover, and while no evidence
exists the rollback is just reverting the eight `.env` keys and restarting. Once
real evidence is in Wasabi, rollback stops being a config change and becomes a
data migration — so validate the cutover with a test collection before the first
real matter.
