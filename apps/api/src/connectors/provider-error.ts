import {
  BadGatewayException,
  ConflictException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { ConnectorError, ProviderApiError } from '@aeg-clouddfir/connectors';
// Not from the connectors package: this one is raised by the API's own token
// factory when a stored secret is missing or will not decrypt.
import { ConnectorCredentialsError } from './token-provider.factory.js';

/**
 * Turn a provider failure into the right HTTP answer.
 *
 * A refusal from Microsoft, Google, Slack or Dropbox is not our server
 * breaking. Letting it escape as an unhandled 500 cost real time here: the
 * custodian list answered `500 Internal Server Error` with no body when the
 * Entra app had not been granted `User.Read.All`. The operator saw an empty
 * page and no reason for it, and the browser then hammered the endpoint,
 * because the query client retries 5xx twice and only skips retries below 500
 * (`apps/web/src/components/Providers.tsx`). The provider's own answer was
 * `403 Authorization_RequestDenied` all along.
 *
 * So the split is by who has to act:
 *
 * - The provider says "no, and asking again will not help" (401/403, bad
 *   credential) → 409. A human must grant consent, reconnect, or fix scopes.
 *   4xx also stops the retry storm.
 * - The provider is rate limiting or briefly unwell (429, 5xx) → 503/502, which
 *   the client is right to retry.
 *
 * Messages come from the connectors package, which sanitizes them; this adds
 * only what the operator needs to know to act.
 */
export function providerHttpError(err: unknown, action: string): HttpException | null {
  if (err instanceof ConnectorCredentialsError) {
    return new ConflictException(
      `${action} failed: the stored credential could not be used. Reconnect this connector.`,
    );
  }

  if (err instanceof ProviderApiError) {
    const code = err.providerCode === undefined ? '' : ` (${err.providerCode})`;

    if (err.status === 401 || err.status === 403) {
      return new ConflictException(
        `${action} was refused by the provider${code}. This connector has not been granted ` +
          `permission for it. An administrator of that organization must grant consent for the ` +
          `app, then run a connection test.`,
      );
    }
    if (err.status === 429) {
      return new ServiceUnavailableException(
        `${action} was rate limited by the provider. Try again shortly.`,
      );
    }
    return new BadGatewayException(
      `${action} failed: the provider returned HTTP ${err.status}${code}.`,
    );
  }

  if (err instanceof ConnectorError) {
    return new BadGatewayException(`${action} failed: ${err.message}`);
  }

  // Not a provider fault. Hand it back so the unhandled-error filter logs the
  // stack and answers 500 — which is the honest reply for our own bug.
  return null;
}

/** Run `fn`, converting provider failures into HTTP answers. */
export async function withProviderErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = providerHttpError(err, action);
    if (mapped === null) throw err;
    throw mapped;
  }
}
