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

For the **quarantine** bucket: versioning is optional and Object Lock is a
liability — you may legitimately need to purge malware. Leave Object Lock off.

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
      "Sid": "ObjectOperations",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::aeg-clouddfir-evidence/*",
        "arn:aws:s3:::aeg-clouddfir-quarantine/*"
      ]
    },
    {
      "Sid": "BucketOperations",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::aeg-clouddfir-evidence",
        "arn:aws:s3:::aeg-clouddfir-quarantine"
      ]
    }
  ]
}
```

Why each of these is actually needed — none is padding:

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

## Step 4 — CORS on the evidence bucket

Previews and downloads are served to the browser via presigned URLs that go
straight to Wasabi, so the bucket must allow the web origin. On the **evidence**
bucket → **Settings** → **CORS**:

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://app.aegclouddfir.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Only `GET`/`HEAD`, and only that one origin. Uploads go through the API, not
direct-to-bucket, so no `PUT` is needed here. Do not use `*` as the origin: these
presigned URLs grant read access to evidence, and a wildcard lets any page a
reviewer has open read them if it obtains a URL.

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
6. Confirm a presigned URL is fetchable from the web origin.
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
