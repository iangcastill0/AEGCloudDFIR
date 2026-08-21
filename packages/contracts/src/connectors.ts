import { z } from 'zod';
import { connectionMode, provider } from './common.js';

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
