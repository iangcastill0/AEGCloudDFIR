import { pino, type Logger } from 'pino';
import type { AppConfig } from '@aeg-clouddfir/config';

export type AppLogger = Logger;

/**
 * Structured JSON logger. Authorization and Cookie headers are redacted as a
 * belt-and-braces measure; request/response bodies are never logged at all.
 */
export function createLogger(config: AppConfig): AppLogger {
  return pino({
    level: config.CDFIR_LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
    base: { service: 'api', version: config.CDFIR_APP_VERSION },
  });
}
