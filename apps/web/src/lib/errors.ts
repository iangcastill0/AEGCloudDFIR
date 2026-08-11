import { apiError } from '@evidencevault/contracts';
import type { z } from 'zod';

export type ErrorEnvelope = z.infer<typeof apiError>;

export class ApiError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly requestId: string | undefined;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'ApiError';
    this.statusCode = envelope.statusCode;
    this.errorCode = envelope.error;
    this.requestId = envelope.requestId;
  }
}

/**
 * Parse an API error body into the shared envelope shape. Tolerates
 * non-JSON bodies (proxies, HTML error pages) by synthesizing an envelope.
 */
export function parseErrorEnvelope(status: number, bodyText: string): ErrorEnvelope {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    parsedJson = null;
  }
  if (parsedJson !== null) {
    const result = apiError.safeParse(parsedJson);
    if (result.success) return result.data;
    // Nest-style envelopes sometimes use message arrays; normalize.
    if (typeof parsedJson === 'object') {
      const obj = parsedJson as Record<string, unknown>;
      const message = Array.isArray(obj.message)
        ? obj.message.map(String).join('; ')
        : typeof obj.message === 'string'
          ? obj.message
          : '';
      if (message) {
        return {
          statusCode: typeof obj.statusCode === 'number' ? obj.statusCode : status,
          error: typeof obj.error === 'string' ? obj.error : httpStatusText(status),
          message,
          requestId: typeof obj.requestId === 'string' ? obj.requestId : undefined,
        };
      }
    }
  }
  return {
    statusCode: status,
    error: httpStatusText(status),
    message: bodyText.trim().slice(0, 300) || `Request failed with status ${status}`,
  };
}

function httpStatusText(status: number): string {
  const known: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return known[status] ?? 'Error';
}

/** Human-readable message for any thrown value, for ErrorState display. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (request ${err.requestId})` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
