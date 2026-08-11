import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { redactConfig, type AppConfig } from '@evidencevault/config';
import './common/http.js';
import { getAppConfig } from './common/config.js';
import { createLogger } from './common/logger.js';
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

  if (config.EV_DEMO_MODE) {
    logger.warn(
      '*** DEMO MODE ACTIVE *** demo seed mode is enabled; never enable this in production',
    );
  }

  const adapter = new FastifyAdapter({
    trustProxy: config.EV_TRUST_PROXY,
    bodyLimit: config.EV_REQUEST_BODY_LIMIT_BYTES,
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
  await fastify.register(cors, {
    origin: config.EV_CORS_ALLOWED_ORIGINS.length > 0 ? config.EV_CORS_ALLOWED_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  // Correlation id: honor a sane inbound x-request-id, always echo it back.
  fastify.addHook('onRequest', (request, reply, done) => {
    request.evRequestId = resolveRequestId(request.headers['x-request-id']);
    void reply.header('x-request-id', request.evRequestId);
    done();
  });

  // Request logging: metadata only, never bodies, never cookie/auth headers.
  fastify.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        req: { method: request.method, url: request.url, requestId: request.evRequestId },
        res: { statusCode: reply.statusCode },
        durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      },
      'request completed',
    );
    done();
  });

  app.enableShutdownHooks();

  await app.listen(config.EV_API_PORT, '0.0.0.0');
  logger.info({ port: config.EV_API_PORT }, 'api listening');
}

bootstrap().catch((err: unknown) => {
  console.error('fatal error during bootstrap', err);
  process.exit(1);
});
