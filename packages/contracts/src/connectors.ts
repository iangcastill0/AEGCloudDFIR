import { z } from 'zod';
import { connectionMode, paginated, provider, uuid } from './common.js';

/**
 * Connector request shapes.
 *
 * These live here, not inside the API service, because keeping them there is
 * what broke the connector flow: the API required a `label` and the web page
 * never sent one, so every "Connect" click returned 400 before the provider was
 * ever contacted. A shared schema means the page cannot build a request the API
 * would reject without a test failing first.
 */

export const createConnectorRequest = z.object({
  provider,
  mode: connectionMode,
  /** Human-readable name, shown until the provider identity is known. */
  label: z.string().min(1).max(200),
});
export type CreateConnectorRequest = z.infer<typeof createConnectorRequest>;

/**
 * Organization setup, POSTed to /connectors/:id/org AFTER the connector row
 * exists. It is a second step on purpose: the credential is stored against a
 * connector that is already audited as created.
 */
export const orgMicrosoftSetupRequest = z.object({
  /** Directory (tenant) ID of the Microsoft Entra tenant. */
  externalTenantId: z.string().min(1).max(200),
});
export type OrgMicrosoftSetupRequest = z.infer<typeof orgMicrosoftSetupRequest>;

export const orgGoogleSetupRequest = z.object({
  serviceAccountJson: z.string().min(2),
  allowedDomains: z.array(z.string().min(1).max(255)).min(1).max(50),
  adminEmail: z.string().email(),
});
export type OrgGoogleSetupRequest = z.infer<typeof orgGoogleSetupRequest>;

/**
 * What POST /connectors returns.
 *
 * The connector is nested, not spread. The web schema used to expect a top-level
 * `id`, which failed with `path: ["id"], expected string` the moment the request
 * stopped being rejected — the shape had simply never been exercised.
 *
 * `adminConsentUrl` is NOT here: it comes from the organization-setup step,
 * POST /connectors/:id/org, which is the only place a credential is supplied.
 */
/** Matches the database's ConnectorStatus enum. */
export const connectorStatus = z.enum(['pending_auth', 'connected', 'error', 'revoked']);

export const connectorSummaryResponse = z.object({
  id: uuid,
  // The FULL provider enum. `upload` is a real connector: every tenant gets one
  // for preserved container files.
  provider,
  mode: connectionMode,
  label: z.string().default(''),
  externalIdentity: z.string().default(''),
  externalTenantId: z.string().default(''),
  allowedDomains: z.array(z.string()).default([]),
  status: connectorStatus,
  statusDetail: z.string().default(''),
  createdAt: z.string(),
  revokedAt: z.string().nullable().default(null),
});

export const createConnectorResponse = z.object({
  connector: connectorSummaryResponse,
  /** Present for delegated OAuth: the browser navigates here to sign in. */
  authorizationUrl: z.string().optional(),
});
export type CreateConnectorResponse = z.infer<typeof createConnectorResponse>;

/** What POST /connectors/:id/org returns. */
export const orgConnectorSetupResponse = z.object({
  ok: z.literal(true),
  /** Microsoft only: an Entra admin must open this to grant consent. */
  adminConsentUrl: z.string().optional(),
  auditScopes: z.array(z.string()).optional(),
});

/**
 * GET /connectors — one row per connector account.
 *
 * `provider` is the FULL enum, including `upload`. Every tenant gets an upload
 * connector automatically for preserved container files, and the web used to
 * declare only microsoft and google here — so one upload row made the whole
 * list fail to parse and the page showed "Something went wrong" with no
 * connectors at all.
 */
export const connectorListItem = connectorSummaryResponse.pick({
  id: true,
  provider: true,
  mode: true,
  label: true,
  externalIdentity: true,
  status: true,
  statusDetail: true,
  createdAt: true,
});
export const connectorListResponse = paginated(connectorListItem);
export type ConnectorListItem = z.infer<typeof connectorListItem>;

// --- IMAP ---

/**
 * Where a mailbox lives, for hosts that speak IMAP.
 *
 * Kept as presets plus a custom option because operators do not memorise IMAP
 * hostnames, and a typo produces a connection error that reads like a
 * credential problem.
 */
export const IMAP_PRESETS = [
  { id: 'yahoo', label: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, secure: true },
  { id: 'icloud', label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true },
  { id: 'gmail', label: 'Gmail (IMAP)', host: 'imap.gmail.com', port: 993, secure: true },
  { id: 'aol', label: 'AOL Mail', host: 'imap.aol.com', port: 993, secure: true },
  {
    id: 'outlook',
    label: 'Outlook.com (IMAP)',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
  },
] as const;

export type ImapPresetId = (typeof IMAP_PRESETS)[number]['id'];

/**
 * Create an IMAP connector.
 *
 * The password is an APP password. Yahoo, iCloud and Gmail all refuse an account
 * password over IMAP, and sending one produces an authentication failure that
 * looks like a wrong password rather than a wrong KIND of password.
 */
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
export type CreateImapConnectorRequest = z.infer<typeof createImapConnectorRequest>;
