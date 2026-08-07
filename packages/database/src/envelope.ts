import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for connector secrets (OAuth refresh tokens,
 * domain-wide-delegation service-account keys).
 *
 * Each secret gets a fresh 256-bit data-encryption key (DEK, AES-256-GCM).
 * The DEK is wrapped by a KeyEncryptionProvider. Rotating the master key
 * means re-wrapping DEKs — payload ciphertexts never need re-encryption.
 */
export interface KeyEncryptionProvider {
  /** Identifier of the active key-encryption key, stored with each secret. */
  readonly activeKeyId: string;
  wrapDek(
    dek: Buffer,
    aad: Buffer,
  ): Promise<{ keyId: string; wrappedDek: Buffer; iv: Buffer; tag: Buffer }>;
  unwrapDek(keyId: string, wrappedDek: Buffer, iv: Buffer, tag: Buffer, aad: Buffer): Promise<Buffer>;
}

export interface EncryptedSecret {
  kekKeyId: string;
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
  ciphertext: Buffer;
  cipherIv: Buffer;
  cipherTag: Buffer;
}

/**
 * Portable local provider: wraps DEKs with a 32-byte master key from the
 * environment (EV_KEK_LOCAL_MASTER_KEY, base64) using AES-256-GCM.
 * External KMS systems (AWS KMS, GCP KMS, Vault Transit) implement the same
 * interface; see docs/guides/key-management.md.
 */
export class LocalAesKeyEncryptionProvider implements KeyEncryptionProvider {
  readonly activeKeyId: string;
  /** keyId -> master key, so rotated keys can still unwrap old DEKs. */
  private readonly keys: Map<string, Buffer>;

  constructor(masterKeysByIds: Record<string, string>, activeKeyId: string) {
    this.keys = new Map();
    for (const [keyId, base64] of Object.entries(masterKeysByIds)) {
      const key = Buffer.from(base64, 'base64');
      if (key.length !== 32) {
        throw new Error(`KEK '${keyId}' must be exactly 32 bytes (base64-encoded)`);
      }
      this.keys.set(keyId, key);
    }
    if (!this.keys.has(activeKeyId)) {
      throw new Error(`active KEK id '${activeKeyId}' has no configured key material`);
    }
    this.activeKeyId = activeKeyId;
  }

  async wrapDek(dek: Buffer, aad: Buffer) {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error('active KEK unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { keyId: this.activeKeyId, wrappedDek, iv, tag: cipher.getAuthTag() };
  }

  async unwrapDek(keyId: string, wrappedDek: Buffer, iv: Buffer, tag: Buffer, aad: Buffer) {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`no KEK material for key id '${keyId}'`);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(wrappedDek), decipher.final()]);
  }
}

/** AAD binds ciphertexts to their tenant + secret identity (anti-swap). */
function buildAad(tenantId: string, secretScope: string): Buffer {
  return Buffer.from(`evidencevault:v1:${tenantId}:${secretScope}`, 'utf8');
}

export async function encryptSecret(
  kek: KeyEncryptionProvider,
  tenantId: string,
  secretScope: string,
  plaintext: Buffer,
): Promise<EncryptedSecret> {
  const aad = buildAad(tenantId, secretScope);
  const dek = randomBytes(32);
  try {
    const cipherIv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dek, cipherIv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const cipherTag = cipher.getAuthTag();
    const wrapped = await kek.wrapDek(dek, aad);
    return {
      kekKeyId: wrapped.keyId,
      wrappedDek: wrapped.wrappedDek,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
      ciphertext,
      cipherIv,
      cipherTag,
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptSecret(
  kek: KeyEncryptionProvider,
  tenantId: string,
  secretScope: string,
  secret: EncryptedSecret,
): Promise<Buffer> {
  const aad = buildAad(tenantId, secretScope);
  const dek = await kek.unwrapDek(secret.kekKeyId, secret.wrappedDek, secret.dekIv, secret.dekTag, aad);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, secret.cipherIv);
    decipher.setAAD(aad);
    decipher.setAuthTag(secret.cipherTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

/** Constant-time comparison helper for verification code paths. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
