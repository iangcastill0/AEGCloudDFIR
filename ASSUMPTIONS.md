# ASSUMPTIONS

This document records the assumptions under which AEG-CloudDFIR is designed and
built. Anything listed here that turns out to be false should be revisited
before relying on the affected behavior.

## Environment and tooling

1. **Build host**: macOS (darwin arm64) with Homebrew. Node.js 22.x and pnpm 11.x
   were installed during bootstrap. No container runtime (Docker Desktop /
   Colima / Podman) was present on the build machine at project start; the
   Docker Compose stack is authored and validated for syntax, and integration
   tests that need real services (PostgreSQL, Redis, OpenSearch, MinIO) run via
   Testcontainers wherever a runtime is available. `VERIFICATION.md` records
   exactly which checks ran against live services and which could not.
2. **Runtime targets**: Node.js 22 LTS for all services. Linux/amd64 and
   linux/arm64 OCI images for deployment.
3. **Self-hosting**: operators can provision PostgreSQL 16, Redis 7,
   OpenSearch 2.x, an S3-compatible object store (Wasabi in production, MinIO
   locally), Authentik, and ClamAV. The application never assumes a specific
   cloud vendor.

## Identity and authentication

4. **Authentik is the only login IdP.** AEG-CloudDFIR is an OIDC relying party
   using authorization-code + PKCE. Local passwords are never stored. MFA
   policy is enforced inside Authentik, not in AEG-CloudDFIR.
5. **OIDC `sub` is stable per user per Authentik instance.** User rows key on
   `(issuer, sub)`. Email is informational and may change.
6. **Group-to-role mapping is optional.** When enabled, the configured group
   claim is authoritative on each login; when disabled, roles are managed in
   AEG-CloudDFIR by `org_admin`s.

## Provider access

7. **Delegated OAuth grants exactly what the signed-in identity can see.**
   The product never claims delegated mode can enumerate or collect other
   users' data. UI copy states this explicitly.
8. **Microsoft organization mode** assumes an Entra tenant admin can create an
   app registration, grant application permissions (`Mail.Read`,
   `Files.Read.All`, `User.Read.All` or narrower via RBAC for Applications /
   application access policies), and complete admin consent. Scoping mailboxes
   is done with Microsoft-supported controls (application access policies /
   RBAC for Applications); AEG-CloudDFIR documents this and honors resulting
   403s as exceptions rather than trying to bypass them.
9. **Google organization mode** assumes a Workspace super admin can create a
   service account, enable domain-wide delegation for the exact scopes listed
   in the setup guide, and restrict it via Google admin controls. AEG-CloudDFIR
   validates the configured domain allowlist before impersonating anyone.
10. **Provider APIs are eventually consistent and rate limited.** Collections
    therefore report completeness _relative to what the API returned_, never
    absolute completeness. Delta/history tokens can expire; when they do, a
    reconciliation scan is triggered and recorded as an exception event.
11. **Gmail `raw` format and Graph `$value` MIME are the best available
    natives.** Where a provider cannot supply RFC 822 bytes (rare Graph cases,
    Drive/Google-native files), the stored artifact is labeled an API export /
    derivative, never presented as a byte-identical native.

## Evidence and storage

12. **SHA-256 is the canonical content hash.** Provider-supplied hashes
    (quickXorHash, MD5) are preserved as metadata but never substitute for a
    locally computed SHA-256 over the preserved bytes.
13. **Object store provides read-after-write consistency** (true for Wasabi,
    MinIO, and modern S3). Immutability beyond "the app never overwrites"
    requires bucket versioning + Object Lock, which only the operator can
    enable; the app detects and reports the actual state and never claims WORM
    when it is not configured.
14. **PostgreSQL is the source of truth**; OpenSearch is a rebuildable index;
    Redis holds only transient job state. Any of the latter two can be wiped
    and rebuilt from PostgreSQL + S3.

## Legal and product posture

15. **Nothing here is legal advice.** Chain-of-custody manifests, hash chains,
    and audit logs _support_ defensibility; admissibility, privacy compliance
    (GDPR/CCPA), and retention obligations require review by qualified counsel.
    The UI repeats this in collection, export, and production screens.
16. **BCC** is indexed only when present in acquired artifacts (sender's own
    sent mail, journal formats). It is never inferred.
17. **No brute-forcing** of encrypted or rights-managed content; such items
    become recorded exceptions.

## Scope decisions made during implementation

18. Demo seed mode uses a local fake provider server speaking
    Graph-shaped and Gmail/Drive-shaped JSON with sanitized RFC 822 fixtures.
    It is compiled only into dev/demo entry points, gated by
    `EV_DEMO_MODE=true`, and clearly labeled in the UI. Production code paths
    use the real connector adapters exclusively.
19. Live-credential verification against real Microsoft/Google tenants is a
    documented manual step (see `VERIFICATION.md`); all connector logic is
    exercised against recorded contract fixtures and the fake server.
20. TIFF Group 4 rendering uses `sharp` (libvips); LibreOffice headless and
    Tesseract run only inside the worker container, never on the host API.
