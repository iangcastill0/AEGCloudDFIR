export * from '@prisma/client';
export { createPrismaClient, withTenantContext, TenantContextError } from './client.js';
export type { TenantScopedTx } from './client.js';
export { withPlatformContext } from './platform.js';
export type { PlatformScopedTx } from './platform.js';
export { bootstrapOrgAdmin, BootstrapError, DEFAULT_BOOTSTRAP_ROLES } from './bootstrap.js';
export type { BootstrapOrgAdminInput, BootstrapOrgAdminResult } from './bootstrap.js';
export {
  canonicalJson,
  computeEventHash,
  GENESIS_HASH,
  appendAuditEvent,
  verifyAuditChain,
} from './audit.js';
export type { AuditEventInput, AuditChainVerification } from './audit.js';
export { LocalAesKeyEncryptionProvider, encryptSecret, decryptSecret } from './envelope.js';
export type { KeyEncryptionProvider, EncryptedSecret } from './envelope.js';
