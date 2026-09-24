# Forensic imports

The **Import** page accepts common archives, SQLite databases, JSON, XML,
property lists, PDFs, images, text files, and logs.

## Storage and truth

The uploaded source is streamed to Wasabi, hashed, verified, and promoted to
the same immutable, content-addressed `originals/sha256/` layout as all other
evidence. It is never replaced by parsed output.

Archive members are stored as separate hashed evidence items and linked to the
source with `container_member`. Crush metadata, bounded previews, and the
versioned analysis manifest are derivatives. The UI labels extracted members
as extracted from a container.

## Access

Before case attachment, only the uploader and organization admins can see an
import. After attachment, assigned case members can open it. Attaching an
import adds references to the case; it does not copy evidence bytes.

## Parser isolation

`crush-parser` contains the pinned Crush Forensics code and a small headless
adapter. It has no database or Wasabi credentials and no published port. The
worker streams one source to it and verifies every returned member hash before
preservation.

The container runs as a non-root user with a read-only root filesystem, dropped
Linux capabilities, a bounded scratch volume, and CPU and memory limits.

This feature adds import ownership fields to the strict OpenSearch mapping.
Worker startup detects an older alias, copies its documents into mapping v3,
checks the copy for failures, and only then swaps the alias. The old alias stays
live if the copy fails.

Default limits:

- 10 GiB source upload
- 25,000 archive entries
- 2 GiB total expanded bytes
- 100:1 expansion ratio
- 3 nested archive levels
- 200 SQLite rows per table preview
- 30 minute parser timeout

These are preview and safety limits. Hitting one does not alter or remove the
preserved source.

## Staging proof

After the operator deploys staging:

1. Import one small fixture from each supported family.
2. Confirm the source SHA-256 shown by the API matches the Wasabi object.
3. Open the parsed tree and a structured preview.
4. Attach one import to a test case and confirm its items appear in Review.
5. Sign in as another user and confirm the unattached import returns 404.
6. Check the audit log for upload, analysis, case attachment, and native
   download events.
7. Inspect the running worker and parser containers, not only CI output.
