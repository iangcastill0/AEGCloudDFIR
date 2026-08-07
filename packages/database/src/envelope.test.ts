import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalAesKeyEncryptionProvider, decryptSecret, encryptSecret } from './envelope.js';

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('envelope encryption', () => {
  it('round-trips a secret', async () => {
    const kek = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1 }, 'kek-1');
    const plaintext = Buffer.from('refresh-token-material-1234567890');
    const enc = await encryptSecret(kek, TENANT_A, 'connector:abc', plaintext);
    expect(enc.kekKeyId).toBe('kek-1');
    expect(enc.ciphertext.equals(plaintext)).toBe(false);
    const dec = await decryptSecret(kek, TENANT_A, 'connector:abc', enc);
    expect(dec.equals(plaintext)).toBe(true);
  });

  it('rejects decryption under a different tenant (AAD binding)', async () => {
    const kek = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1 }, 'kek-1');
    const enc = await encryptSecret(kek, TENANT_A, 'connector:abc', Buffer.from('s'));
    await expect(decryptSecret(kek, TENANT_B, 'connector:abc', enc)).rejects.toThrow();
  });

  it('rejects decryption under a different secret scope', async () => {
    const kek = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1 }, 'kek-1');
    const enc = await encryptSecret(kek, TENANT_A, 'connector:abc', Buffer.from('s'));
    await expect(decryptSecret(kek, TENANT_A, 'connector:OTHER', enc)).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const kek = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1 }, 'kek-1');
    const enc = await encryptSecret(kek, TENANT_A, 'connector:abc', Buffer.from('secret'));
    enc.ciphertext[0] = (enc.ciphertext[0]! + 1) % 256;
    await expect(decryptSecret(kek, TENANT_A, 'connector:abc', enc)).rejects.toThrow();
  });

  it('supports key rotation: old key unwraps, new key wraps', async () => {
    const oldKek = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1 }, 'kek-1');
    const enc = await encryptSecret(oldKek, TENANT_A, 'connector:abc', Buffer.from('secret'));
    // After rotation both keys are configured; kek-2 is active.
    const rotated = new LocalAesKeyEncryptionProvider({ 'kek-1': KEY_1, 'kek-2': KEY_2 }, 'kek-2');
    const dec = await decryptSecret(rotated, TENANT_A, 'connector:abc', enc);
    expect(dec.toString()).toBe('secret');
    const reenc = await encryptSecret(rotated, TENANT_A, 'connector:abc', dec);
    expect(reenc.kekKeyId).toBe('kek-2');
  });

  it('refuses non-32-byte master keys', () => {
    expect(
      () => new LocalAesKeyEncryptionProvider({ 'kek-1': Buffer.from('short').toString('base64') }, 'kek-1'),
    ).toThrow(/32 bytes/);
  });
});
