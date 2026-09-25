# Application security review — AEGCloudDFIR

**Scope:** `apps/api`, `apps/worker`, `packages/connectors`, `packages/evidence`, `packages/search`  
**Focus:** SSRF, webhooks/callbacks, outbound fetches, command injection, path traversal, unsafe deserialization, template injection, secrets leakage, open redirects, HTML preview sanitizer, presigned URL authz, Redis/BullMQ job injection  
**Method:** Source review of real sinks and call paths (not inference from threat-model text alone)  
**Date:** 2026-09-25

## Executive summary

One **validated Medium** finding: **IMAP connector host/port is attacker-chosen with no SSRF controls**, and the API (on Test) plus the worker (on collect) open TCP connections to that target from the service network. That contradicts `THREAT_MODEL.md`, which claims there are no user-controlled fetch targets and an egress allowlist for provider redirects.

Several nearby areas were investigated and **not** raised as medium+: OAuth open redirects, email HTML sanitizer, spawn/exec arg handling, object-key path traversal, presign authz, CSRF-exempt download refresh, outbox-only job enqueue from the API, and `NEXT_PUBLIC_*` usage.

---

## Validated findings (medium+)

### F1 — IMAP connector SSRF via arbitrary host/port

| Field | Detail |
| --- | --- |
| **Severity** | Medium |
| **Attacker** | Authenticated `org_admin` in a tenant (or anyone who compromises such a session) |
| **Controlled input** | `host`, `port`, `secure` on `POST /api/v1/connectors/imap` (Zod allows any non-empty host string ≤255 and any port 1–65535) |
| **Reachability** | (1) Create IMAP connector → (2) `POST /api/v1/connectors/:id/test` runs `ImapEmailConnector.listMailFolders()` **inside the API process**; (3) a later collection makes the **worker** open the same host from the docker/k8s service network |
| **Impact** | Server-side TCP reachability into the shared backend network (Redis, Postgres, OpenSearch, sibling containers, link-local/cloud metadata if present). Enables internal service discovery / port probing via success vs auth/timeout errors. Protocol is IMAP, so full Redis/HTTP command injection is unlikely, but the blast radius is still “tenant admin can make platform sockets talk to places the product promised were not user-controllable.” |
| **Primary location** | `packages/contracts/src/connectors.ts` (`createImapConnectorRequest`); `apps/api/src/connectors/connectors.service.ts` (`createImap`, `test` IMAP branch); `packages/connectors/src/imap/connector.ts` (`buildImapClient`) |
| **Evidence** | See below |

**Evidence**

1. Schema accepts arbitrary host/port — no allowlist, no private-IP block, no DNS pinning:

```138:147:packages/contracts/src/connectors.ts
export const createImapConnectorRequest = z.object({
  label: z.string().min(1).max(200),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** Implicit TLS (993). False means STARTTLS, normally on 143. */
  secure: z.boolean(),
  /** The full email address in almost every case. */
  username: z.string().min(1).max(320),
  appPassword: z.string().min(1).max(512),
});
```

2. Create stores the operator-supplied host and opens it later; Test connects from the API:

```1272:1282:apps/api/src/connectors/connectors.service.ts
    } else if (account.provider === Provider.imap) {
      // A real connection and a real LIST. Anything less would report "ok" for a
      // credential that has never spoken to the server.
      const settings = await this.imapSettings(account);
      if (settings === null) {
        ok = false;
        detail = 'no stored IMAP credential; recreate the connector';
      } else {
        try {
          const discovery = await new ImapEmailConnector(settings).listMailFolders();
```

3. Client construction passes `host`/`port` straight into `ImapFlow` with no host policy:

```78:91:packages/connectors/src/imap/connector.ts
export function buildImapClient(options: ImapConnectorOptions): ImapFlow {
  if (options.clientFactory !== undefined) return options.clientFactory(options);
  return new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.username, pass: options.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // The library's own chatter is not our log; failures surface as thrown
    // errors and are recorded by the caller.
    logger: false,
  });
}
```

4. Documented control that is **not** implemented for this path:

```70:70:THREAT_MODEL.md
| SSRF from user-supplied URLs / provider redirects        | egress allowlist per connector (graph.microsoft.com, login.microsoftonline.com, gmail/googleapis.com, oauth2.googleapis.com); no user-controlled fetch targets; redirects validated against allowlist                                                       |
```

No `allowlist` / private-network guard exists under `packages/connectors` or `apps/api` for IMAP (or for Graph `Location` follows — see discarded close-calls).

**Suggested fix (not applied in this review):** restrict IMAP hosts to a preset allowlist and/or block literal IPs + RFC1918/link-local/metadata ranges after resolve; prefer connecting only from the worker with egress policy; never probe from the API process.

---

## Discarded close-calls (why not medium+)

| Area | Why discarded |
| --- | --- |
| **Graph `followRedirectWithoutAuth` with no Location host allowlist** (`packages/connectors/src/http.ts`) | Location comes from Microsoft Graph after an authenticated Graph call. Attacker cannot set it without compromising Graph/TLS. Defense-in-depth gap vs threat-model text; not a user-reachable SSRF today. |
| **OAuth / login open redirect** (`validateRedirectTo` in `apps/api/src/auth/oidc-helpers.ts`) | Relative-path only; rejects `//`, `\`, CR/LF. Connector post-callback redirects are fixed to `CDFIR_WEB_PUBLIC_URL/connectors?...`. |
| **Email HTML sanitizer bypass** (`packages/evidence/src/processing/safe-preview.ts`) | Strong allowlist; remote/data images stripped; `cid:` rewritten only via resolver to `/api/v1/evidence/{uuid}/preview`. UI uses `sandbox=""` iframe. No validated bypass found. |
| **Command injection via soffice / tesseract / pstb / pdftotext** | `spawn(cmd, args[])` (no shell). Filenames forced to `input.<safeExt>`; langs/extensions constrained or from config, not free-form user argv. |
| **Path traversal in object keys / uploads / exports** | `sanitizeFilename` / `assertKeyInTenant` / `assertPathPart` reject `..`, separators, control chars. Presign refuses staging/foreign/unclassified keys. |
| **Import tar unpack** (`import-analyze.ts`) | Entry names matched to parser manifest; bytes staged to S3 — not written to a local path taken from `artifact.path`. |
| **Unsafe YAML / pickle / template deserialize** | No `yaml.load` / `vm` / template engines on untrusted input in scope. JSON.parse is used on provider responses, sealed cookies, and tokens with Zod/HMAC where needed. |
| **Secrets in `NEXT_PUBLIC_*` / source maps** | Only `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_AUTHENTIK_URL`. Web `tsconfig` has `sourceMap: false`. |
| **Presigned URL minting without authz** | Evidence/export/production/collection paths require session + tenant (+ roles); store validates tenant key prefix before signing. |
| **CSRF-exempt `POST .../exports/:id/download/urls`** | Bearer download token only; no session guard; exportId must match token claims; covered by `csrf-exemptions.test.ts` registry. |
| **Unauthenticated webhooks (Graph notifications, Google push)** | No inbound webhook controllers found. Collections poll providers; threat model claim matches code. |
| **Redis/BullMQ job injection from the internet** | Compose binds Redis to `127.0.0.1` on the host; API writes jobs only via transactional outbox. Redis has no `requirepass` on the docker network — residual risk **after** already being inside that network, not an unauthenticated internet sink. |
| **OAuth callback public routes** | `@Public()` but CSRF N/A (GET); state sealed to session cookie; failures redirect with coarse reasons, not token material. Access-log redaction covers `code`/`state` (`log-url.ts`). |

---

## Controls that looked solid (short)

- Tenant RLS + `withTenantContext` for evidence queries.
- Envelope encryption for connector secrets; audit summaries omit passwords.
- Content-disposition sanitization for presigned downloads.
- Outbox unique `(topic, dedupKey)` with intentional reindex tokens.
- Spawn-based converters with timeouts and temp dirs under `mkdtemp`.

---

## Finding ID index

| ID | Severity | Title |
| --- | --- | --- |
| F1 | Medium | IMAP connector SSRF via arbitrary host/port |
