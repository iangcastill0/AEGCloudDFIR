import { HttpException } from '@nestjs/common';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { redactConfig, type AppConfig } from '@aeg-clouddfir/config';
import './common/http.js';
import { getAppConfig } from './common/config.js';
import { createLogger } from './common/logger.js';
import { UnhandledErrorFilter } from './common/error-filter.js';
import { resolveRequestId } from './common/request-id.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // Fail fast on invalid environment before Nest is constructed.
  let config: AppConfig;
  try {
    config = getAppConfig();
  } catch (err) {
    if (err instanceof Error && err.name === 'ConfigValidationError') {
      // Key-level messages only; secret values are never included.
      console.error(err.message);
    } else {
      console.error('failed to load configuration', err);
    }
    process.exit(1);
  }

  const logger = createLogger(config);
  logger.debug({ config: redactConfig(config) }, 'effective configuration (redacted)');

  if (config.CDFIR_DEMO_MODE) {
    logger.warn(
      '*** DEMO MODE ACTIVE *** demo seed mode is enabled; never enable this in production',
    );
  }

  const adapter = new FastifyAdapter({
    trustProxy: config.CDFIR_TRUST_PROXY,
    bodyLimit: config.CDFIR_REQUEST_BODY_LIMIT_BYTES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: false,
  });

  // pnpm resolves two fastify 4.x copies (the app's own and the one nested
  // under @nestjs/platform-fastify); they are runtime-compatible but nominally
  // distinct to TypeScript, so plugins are registered against the app's copy.
  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;

  await fastify.register(helmet, {
    // API responses are data, never documents: lock the CSP down completely.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    noSniff: true,
  });
  await fastify.register(cookie);
  // Container-file uploads (PST/OST) stream through the evidence store and
  // are never buffered; the size limit is separate from the JSON body limit.
  await fastify.register(multipart, {
    limits: { files: 1, fileSize: config.CDFIR_UPLOAD_MAX_BYTES },
  });
  await fastify.register(cors, {
    origin:
      config.CDFIR_CORS_ALLOWED_ORIGINS.length > 0 ? config.CDFIR_CORS_ALLOWED_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  // Correlation id: honor a sane inbound x-request-id, always echo it back.
  fastify.addHook('onRequest', (request, reply, done) => {
    request.cdfirRequestId = resolveRequestId(request.headers['x-request-id']);
    void reply.header('x-request-id', request.cdfirRequestId);
    done();
  });

  // Request logging: metadata only, never bodies, never cookie/auth headers.
  fastify.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        req: { method: request.method, url: request.url, requestId: request.cdfirRequestId },
        res: { statusCode: reply.statusCode },
        durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      },
      'request completed',
    );
    done();
  });

  // Unhandled errors: log the cause, not just the status code.
  //
  // Without this a 500 appeared in the log as `"res":{"statusCode":500}` and
  // nothing else. A staging login failed exactly that way, and the reason — the
  // database had no schema at all — was only found in the WORKER's log. Client
  // errors are already visible in the response, so only 5xx and non-HTTP throws
  // are logged, and never the request body.
  fastify.addHook('onError', (request, reply, error, done) => {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status >= 500) {
      logger.error(
        {
          req: { method: request.method, url: request.url, requestId: request.cdfirRequestId },
          err: {
            name: error.name,
            message: error.message,
            // Prisma puts the useful part in `code` (42P01 = table missing).
            ...(typeof (error as { code?: unknown }).code === 'string'
              ? { code: (error as { code: string }).code }
              : {}),
          },
        },
        'request failed',
      );
    }
    done();
  });

  // NestFactory runs with `logger: false`, which also silences Nest's own
  // exception logging. Without this filter a 500 leaves no trace at all: the
  // access log records the status code and the error itself is discarded.
  app.useGlobalFilters(new UnhandledErrorFilter(logger));

  app.enableShutdownHooks();

  await app.listen(config.CDFIR_API_PORT, '0.0.0.0');
  logger.info({ port: config.CDFIR_API_PORT }, 'api listening');
}

bootstrap().catch((err: unknown) => {
  console.error('fatal error during bootstrap', err);
  process.exit(1);
});
