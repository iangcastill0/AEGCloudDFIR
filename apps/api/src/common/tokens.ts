/** Dependency-injection tokens for app-wide singletons. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const PRISMA = Symbol('PRISMA');
export const LOGGER = Symbol('LOGGER');
/** KeyEncryptionProvider for envelope-encrypting connector secrets. */
export const KEY_ENCRYPTION = Symbol('KEY_ENCRYPTION');
/** SearchAdapter (OpenSearch by default). */
export const SEARCH_ADAPTER = Symbol('SEARCH_ADAPTER');
/** EvidenceObjectStore over S3-compatible storage. */
export const EVIDENCE_STORE = Symbol('EVIDENCE_STORE');
/** Optional FetchLike override for provider HTTP (tests/demo). */
export const CONNECTOR_FETCH = Symbol('CONNECTOR_FETCH');
