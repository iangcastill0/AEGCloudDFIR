# Wasabi setup guide

AEG-CloudDFIR stores all evidence binaries in S3-compatible object storage.
This guide configures Wasabi for production; MinIO is used locally with the
same code path.

## 1. Buckets

Create two buckets in the same region:

| Bucket          | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `ev-evidence`   | originals, derivatives, manifests, exports, productions          |
| `ev-quarantine` | malware-flagged originals (retained, never rendered unsandboxed) |

Region choice matters for latency to your workers. Set:

```
EV_S3_ENDPOINT=https://s3.<region>.wasabisys.com   # e.g. s3.us-east-1.wasabisys.com
EV_S3_REGION=<region>
EV_S3_FORCE_PATH_STYLE=false
```

## 2. Versioning and Object Lock (WORM)

Immutability layers, weakest to strongest:

1. Application discipline: AEG-CloudDFIR never overwrites/deletes under
   `originals/` outside the governed deletion workflow.
2. IAM policy: deny `s3:DeleteObject`/`s3:PutObject` on existing original keys
   for the application credential (see policy below).
3. **Bucket versioning + Object Lock** — real WORM. Object Lock must be
   enabled **at bucket creation** (`aws s3api create-bucket
--object-lock-enabled-for-bucket ...` against the Wasabi endpoint), then
   configure a default retention mode/duration appropriate to your matters
   (compliance mode cannot be shortened, even by root — decide with counsel).

AEG-CloudDFIR **detects and reports** the actual bucket state (versioning +
Object Lock) on the admin screen and in collection manifests. It never claims
WORM immutability unless both are actually enabled.

## 3. Credentials and least-privilege policy

Create a dedicated sub-user + access key for AEG-CloudDFIR. Example policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AppReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketVersioning",
        "s3:GetObjectLockConfiguration",
        "s3:GetObjectRetention",
        "s3:AbortMultipartUpload",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": [
        "arn:aws:s3:::ev-evidence",
        "arn:aws:s3:::ev-evidence/*",
        "arn:aws:s3:::ev-quarantine",
        "arn:aws:s3:::ev-quarantine/*"
      ]
    },
    {
      "Sid": "ProtectOriginals",
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:PutObjectRetention"],
      "Resource": ["arn:aws:s3:::ev-evidence/tenants/*/originals/*"]
    }
  ]
}
```

`DeleteObject` on originals is denied even to the app credential; governed
deletion runs under a separate operator credential after the two-phase
workflow produces its deletion manifest.

## 4. CORS

Browsers only touch presigned GET URLs. Restrict CORS on `ev-evidence` to your
web origin:

```json
[
  {
    "AllowedOrigins": ["https://evidencevault.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "MaxAgeSeconds": 300
  }
]
```

## 5. Lifecycle

- `tenants/*/staging/` — expire incomplete/abandoned staging objects after 7
  days (staging objects are deleted on promote; this catches crashes).
- Do **not** add expiry lifecycle rules to `originals/`, `manifests/`, or
  `productions/`; retention is governed by tenant policy + legal holds inside
  AEG-CloudDFIR.
- Abort incomplete multipart uploads after 7 days.

## 6. Verification checklist

1. `aws s3api get-bucket-versioning --bucket ev-evidence --endpoint-url $EV_S3_ENDPOINT` → `Enabled`
2. `aws s3api get-object-lock-configuration --bucket ev-evidence --endpoint-url $EV_S3_ENDPOINT` → your mode
3. In AEG-CloudDFIR: Admin → Storage shows “versioning enabled / Object Lock enabled (mode)”.
4. Upload+promote a demo item, then attempt `aws s3api delete-object` on its
   original key with the app credential → `AccessDenied`.
