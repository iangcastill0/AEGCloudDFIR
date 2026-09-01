import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Log the error behind a 500. Without this, there is no error anywhere.
 *
 * NestFactory is created with `logger: false`, which turns off Nest's own
 * exception logging along with everything else. The result: a failing request
 * produced one line saying `"statusCode":500` and nothing at level 40 or 50 in
 * the whole log.
 *
 * That cost a real investigation. A production died on a PostgreSQL
 * bind-parameter limit and the only way to find it was reading code and
 * reasoning about parameter counts, because the exception itself was discarded.
 * In a codebase whose stated fear is "reports success, silently broken", an
 * unlogged 500 is the same fault wearing a different hat.
 *
 * What the CLIENT gets is unchanged and deliberately vague: internal messages
 * can carry table names, ids and query fragments, and none of that belongs in a
 * browser. The detail goes to the log, which is the place that already holds
 * privileged information.
 */

export interface ErrorLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Everything worth knowing about a thrown value, including non-Errors. */
export function describeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack === undefined ? {} : { stack: err.stack }),
    };
  }
  // Code can throw anything. A bare string or object must still be readable
  // rather than logged as "[object Object]".
  if (typeof err === 'string') return { name: 'ThrownString', message: err };
  try {
    return { name: 'ThrownValue', message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { name: 'ThrownValue', message: String(err) };
  }
}

/** The status a thrown value should produce. Anything unrecognised is a 500. */
export function statusFor(err: unknown): number {
  if (err instanceof HttpException) return err.getStatus();
  return 500;
}

@Catch()
export class UnhandledErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const status = statusFor(exception);

    // 4xx is the API working as designed — a bad request, a missing row, a
    // conflict. Logging every one of those as an error would bury the 500s
    // this filter exists to surface.
    if (status >= 500) {
      const described = describeError(exception);
      this.logger.error(
        {
          err: described,
          req: { method: request.method, url: request.url, requestId: request.id },
          statusCode: status,
        },
        'request failed with an unhandled error',
      );
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      void reply.status(status).send(typeof body === 'string' ? { message: body } : body);
      return;
    }

    void reply.status(500).send({ statusCode: 500, message: 'Internal server error' });
  }
}
