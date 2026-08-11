# Runbook: key rotation

See docs/guides/key-management.md for the model.

## KEK (connector secrets)

1. `openssl rand -base64 32` → store as kek-2 in the secret manager.
2. Deploy with both keys available and `EV_KEK_ACTIVE_KEY_ID=kek-2`.
3. Run the rewrap pass; confirm `SELECT DISTINCT "kekKeyId" FROM connector_secrets` shows only kek-2.
4. Remove kek-1 material next deploy. Audit trail: rewrap emits `connector.secret_rotated` events.

## Session secret

Rotate `EV_SESSION_SECRET`; all sessions invalidate; no data impact.

## OIDC client secret

Create the new secret in Authentik, update `EV_OIDC_CLIENT_SECRET`, deploy, delete the old one in Authentik.

## S3 credentials

Create second Wasabi key, deploy, delete first key. Presigned URLs issued
under the old key die with it — acceptable (TTL ≤ 5 min).
