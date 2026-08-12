# ADR-008: Envelope encryption via KeyEncryptionProvider

Status: accepted · Date: 2026-08-07

## Context

Refresh tokens and DWD service-account keys are the highest-value secrets and
must be portable across hosting providers.

## Decision

Each secret gets a random 256-bit DEK (AES-256-GCM). The DEK is wrapped by a
KeyEncryptionProvider; the default local provider wraps with a master key from
CDFIR_KEK_LOCAL_MASTER_KEY (base64, 32 bytes) using AES-256-GCM with key id +
AAD (tenant, secret id). Rows store {keyId, wrappedDek, iv, tag, ciphertext}.
KMS adapters (AWS/GCP/Vault) implement the same wrap/unwrap interface.

## Consequences

Key rotation = rewrap DEKs, not re-encrypt payloads. Secrets are decrypted
only in the connector process, never logged, never returned by any API.
