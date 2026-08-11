# Key management

## What is encrypted with what

| Material | Mechanism |
|---|---|
| Connector refresh tokens, Google DWD service-account keys | Envelope encryption: per-secret AES-256-GCM DEK, wrapped by the active KEK via `KeyEncryptionProvider`; AAD binds ciphertext to `(tenantId, secretScope)` |
| Login session cookies | AES-256-GCM sealed with a key derived from `EV_SESSION_SECRET` |
| Collection manifest signatures | HMAC-SHA256 with a key HKDF-derived from the KEK master key (`info: manifest-signing-v1`) |
| Evidence at rest | Object-store SSE (enable on Wasabi) + TLS in transit |

## Local KEK provider (default)

```
EV_KEK_PROVIDER=local-aes256gcm
EV_KEK_LOCAL_MASTER_KEY=<base64, exactly 32 bytes>   # openssl rand -base64 32
EV_KEK_ACTIVE_KEY_ID=kek-1
```

The master key exists only in the environment/secret manager. Losing it makes
all stored connector secrets undecryptable (evidence itself is unaffected;
connectors must be re-linked).

## Rotation

1. Generate a new key, configure both: keep the old key available under its
   key id, set `EV_KEK_ACTIVE_KEY_ID=kek-2` with the new material.
2. Run the rewrap task (`scripts/` roadmap: `kek-rotate`) which unwraps each
   `ConnectorSecret` DEK with its recorded `kekKeyId` and rewraps with the
   active key — payload ciphertexts are untouched (that is the point of
   envelope encryption).
3. After all rows show `kekKeyId=kek-2`, retire the old key.
4. Session secret rotation (`EV_SESSION_SECRET`) simply invalidates active
   sessions; users re-login.

## External KMS adapters

`KeyEncryptionProvider` is a two-method interface (`wrapDek`, `unwrapDek`,
plus `activeKeyId`). Documented adapter shapes:

- **AWS KMS**: `wrapDek` → `Encrypt` with a KMS CMK (key id = key ARN),
  `unwrapDek` → `Decrypt`; AAD passed as `EncryptionContext`.
- **GCP KMS**: `Encrypt`/`Decrypt` on a key ring key with
  `additionalAuthenticatedData`.
- **Vault Transit**: `transit/encrypt/<key>` with `context` (derived keys).

Implement in `packages/database/src/envelope-<provider>.ts` and select via
`EV_KEK_PROVIDER`. The row format (`kekKeyId`, wrapped DEK, IVs, tags) is
provider-agnostic, so migrating providers = a rewrap pass.
