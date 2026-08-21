/**
 * Payload builders for the connector pages.
 *
 * These exist so the browser's request can be checked against the API's own Zod
 * schema in a test. The page used to build the create payload inline and left
 * out `label`, which the API requires — so every "Connect" click returned 400
 * and no provider was ever contacted. A missing field is not visible by reading
 * two files side by side; it is visible when one schema validates both.
 */
import {
  createConnectorRequest,
  orgGoogleSetupRequest,
  orgMicrosoftSetupRequest,
  type CreateConnectorRequest,
  type OrgGoogleSetupRequest,
  type OrgMicrosoftSetupRequest,
} from '@aeg-clouddfir/contracts';

export type ConnectorProvider = 'microsoft' | 'google';

const PROVIDER_NAMES: Record<ConnectorProvider, string> = {
  microsoft: 'Microsoft 365',
  google: 'Google Workspace',
};

/**
 * A name for a connector that does not have a provider identity yet.
 *
 * The list shows the provider identity once sign-in finishes; until then it
 * shows this. "Google Workspace" alone would repeat for every attempt, so the
 * date is included — a reviewer with three failed attempts can tell them apart.
 */
export function defaultConnectorLabel(
  provider: ConnectorProvider,
  mode: 'delegated' | 'organization',
  now: Date,
): string {
  const when = now.toISOString().slice(0, 10);
  const kind = mode === 'delegated' ? 'personal' : 'organization';
  return `${PROVIDER_NAMES[provider]} (${kind}) ${when}`;
}

/** The create-connector request body, validated against the API's schema. */
export function buildCreateConnector(input: {
  provider: ConnectorProvider;
  mode: 'delegated' | 'organization';
  label: string;
  now: Date;
}): CreateConnectorRequest {
  const label =
    input.label.trim() === ''
      ? defaultConnectorLabel(input.provider, input.mode, input.now)
      : input.label.trim();
  return createConnectorRequest.parse({ provider: input.provider, mode: input.mode, label });
}

/**
 * The organization-setup body for POST /connectors/:id/org.
 *
 * Microsoft's field is `externalTenantId`. The page used to send `entraTenantId`
 * inside a `create` call that ignored it entirely, so organization mode could
 * never have worked either.
 */
export function buildMicrosoftOrgSetup(externalTenantId: string): OrgMicrosoftSetupRequest {
  return orgMicrosoftSetupRequest.parse({ externalTenantId: externalTenantId.trim() });
}

export function buildGoogleOrgSetup(input: {
  serviceAccountJson: string;
  allowedDomains: string;
  adminEmail: string;
}): OrgGoogleSetupRequest {
  return orgGoogleSetupRequest.parse({
    serviceAccountJson: input.serviceAccountJson,
    // One per line or comma separated, whichever the operator typed.
    allowedDomains: input.allowedDomains
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    adminEmail: input.adminEmail.trim(),
  });
}
